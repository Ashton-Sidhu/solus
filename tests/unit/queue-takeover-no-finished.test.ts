import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendSession, NormalizedEvent, Session, SessionStatus } from '@solus/contracts/types'
import type { AttentionEntry } from '@solus/contracts/attention-types'
import type { AgentBackend } from '@solus/server/execution/agents/agent-backend'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let ProviderEvents: typeof import('@solus/server/execution/sessions/provider-events')['ProviderEvents']
let SessionStatuses: typeof import('@solus/server/execution/sessions/session-statuses')['SessionStatuses']
let AttentionService: typeof import('@solus/server/attention/attention-service')['AttentionService']
let FINISHED_CONFIRM_MS: number
beforeAll(async () => {
  ;({ ProviderEvents } = await import('@solus/server/execution/sessions/provider-events'))
  ;({ SessionStatuses } = await import('@solus/server/execution/sessions/session-statuses'))
  ;({ AttentionService, FINISHED_CONFIRM_MS } = await import('@solus/server/attention/attention-service'))
})

// WHY: a run that ends a moment before its continuation (a queued prompt)
// starts is not finished. Before this, the session went running → completed →
// running: every client flickered, the in-app toast and badge said "finished",
// and the Live Activity reported a completion that was not one.

const SESSION = 'solus-session'
const THREAD = 'codex-thread'
const taskComplete: NormalizedEvent = { type: 'task_complete', result: 'done', costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: THREAD }

/** A clock the test moves by hand. */
function fakeSchedule() {
  let now = 0
  const timers = new Set<{ at: number; run: () => void }>()
  const schedule = (run: () => void, delayMs: number) => {
    const timer = { at: now + delayMs, run }
    timers.add(timer)
    return () => { timers.delete(timer) }
  }
  const advance = (ms: number) => {
    now += ms
    for (const timer of [...timers]) {
      if (timer.at > now) continue
      timers.delete(timer)
      timer.run()
    }
  }
  return { schedule, advance, pending: () => timers.size }
}

describe('a turn a queued prompt takes over', () => {
  function setup(queueReady: boolean) {
    const statuses: SessionStatus[] = []
    const settledTurns: string[] = []
    const queueRuns: string[] = []
    const queue = { ready: queueReady }
    const activeSessions = new Map<string, BackendSession>([[SESSION, {
      sessionId: SESSION, agentSessionId: THREAD, backendId: 'codex', status: 'running',
      pendingInputEvents: [], lastActivityAt: 0, promptCount: 1,
    }]])
    const runtime = {
      activeSessions,
      agentSessionToSession: new Map([[THREAD, SESSION]]),
      activeRunRequests: new Map(),
      missingRunCounts: new Map(),
      turnLog: new Map(),
      launcher: { pendingStarts: new Map() },
      orchestration: undefined,
      isShuttingDown: false,
      statuses: {
        setStatus: (sessionId: string, status: SessionStatus) => {
          statuses.push(status)
          const session = activeSessions.get(sessionId)
          if (session) session.status = status
        },
        queueTurnSettlement: (_sessionId: string, _session: BackendSession, outcome: string) => settledTurns.push(outcome),
      },
      inputRequests: { expirePendingInput: () => {}, stampTurnAuthor: () => {} },
      sessionEmitter: { onEvent: () => {}, recordTerminal: () => {} },
      rateLimitPark: { currentRateLimitEvent: () => null },
      handoffs: { handoffCarry: { settle: () => {} } },
      scheduler: { hasReadyQueuedRequest: () => queue.ready, processQueueForSession: (sessionId: string) => queueRuns.push(sessionId) },
      flushPendingSession: () => {},
      emitError: () => {},
      publish: () => {},
      reportToActiveRun: () => {},
    }
    const backend = Object.assign(new EventEmitter(), {
      id: 'codex' as const,
      getSessionHandle: () => undefined,
      getPendingHandles: () => [],
      hasBackgroundTasks: () => false,
    })
    // SAFETY: the provider events read only the members above in these paths.
    new ProviderEvents(runtime as unknown as SessionRuntime).wire(backend as unknown as AgentBackend)
    const endTurn = () => {
      backend.emit('normalized', THREAD, taskComplete)
      backend.emit('exit', THREAD, 0, null)
    }
    return { statuses, settledTurns, queueRuns, queue, backend, endTurn }
  }

  test('publishes no completed status, settles the turn, and hands the session to the queue', () => {
    const { statuses, settledTurns, queueRuns, endTurn } = setup(true)
    endTurn()
    expect(statuses).toEqual([])
    expect(settledTurns).toEqual(['completed'])
    expect(queueRuns).toEqual([SESSION])
  })

  test('a turn with nothing queued completes as before', () => {
    const { statuses, settledTurns, endTurn } = setup(false)
    endTurn()
    expect(statuses).toEqual(['completed', 'completed'])
    expect(settledTurns).toEqual([])
  })

  test('a prompt removed before the exit lets the turn complete once', () => {
    const { statuses, settledTurns, queue, backend } = setup(true)
    backend.emit('normalized', THREAD, taskComplete)
    queue.ready = false
    backend.emit('exit', THREAD, 0, null)
    expect(statuses).toEqual(['completed'])
    expect(settledTurns).toEqual(['completed'])
  })
})

describe('the finished attention entry waits out its confirm window', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'solus-finished-confirm-'))
    dirs.push(dir)
    const clock = fakeSchedule()
    const attention = new AttentionService(join(dir, 'attention.json'), clock.schedule)
    const published: AttentionEntry[][] = []
    attention.onChange((entries) => published.push(entries))
    const activeSessions = new Map<string, BackendSession>([[SESSION, {
      sessionId: SESSION, agentSessionId: THREAD, backendId: 'codex', status: 'running',
      pendingInputEvents: [], lastActivityAt: 0, promptCount: 1,
    }]])
    // SAFETY: attention sync reads only the sessions and the attention service.
    const statuses = new SessionStatuses({ activeSessions, attention } as unknown as SessionRuntime)
    if (statuses.runWatchdogTimer) clearInterval(statuses.runWatchdogTimer)
    const sync = (status: SessionStatus) => statuses.syncAttention(THREAD, SESSION, status)
    const finished = () => published.filter((entries) => entries.some((entry) => entry.kind === 'finished'))
    return { attention, clock, published, sync, finished }
  }

  test('running → completed → running inside the window publishes no finished entry', () => {
    const { clock, sync, finished } = setup()
    sync('running')
    sync('completed')
    clock.advance(FINISHED_CONFIRM_MS - 1)
    sync('running')
    clock.advance(FINISHED_CONFIRM_MS)
    expect(finished()).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  test('the final completion publishes once, after the window, even when re-asserted', () => {
    const { attention, clock, sync, finished } = setup()
    sync('completed')
    clock.advance(FINISHED_CONFIRM_MS - 1)
    // The exit asserts completed again; the first window holds.
    sync('completed')
    expect(attention.get(THREAD)).toBeUndefined()
    clock.advance(1)
    expect(finished()).toHaveLength(1)
    expect(attention.get(THREAD)?.kind).toBe('finished')
    clock.advance(FINISHED_CONFIRM_MS * 2)
    expect(finished()).toHaveLength(1)
  })

  test('a failure is recorded at once and replaces a waiting finish', () => {
    const { attention, clock, sync } = setup()
    sync('completed')
    sync('failed')
    expect(attention.get(THREAD)?.kind).toBe('failed')
    clock.advance(FINISHED_CONFIRM_MS)
    expect(attention.get(THREAD)?.kind).toBe('failed')
  })

  test('shutdown records a waiting finish and leaves no timer', () => {
    const { attention, clock, sync } = setup()
    sync('completed')
    attention.dispose()
    expect(attention.get(THREAD)?.kind).toBe('finished')
    expect(clock.pending()).toBe(0)
  })
})

describe('the finished sound on a client', () => {
  const previousState = (globalThis as unknown as { $state?: unknown }).$state
  afterEach(() => {
    if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
    else (globalThis as unknown as { $state: unknown }).$state = previousState
  })

  async function setup(status: SessionStatus) {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
    const { folderLocation } = await import('@solus/workspace-ui/contexts/workspace/run-location')
    const session = {
      id: SESSION, status, messages: [], outboundPrompts: [], permissionQueue: [], questionQueue: [],
      run: { location: folderLocation({ serverId: 'local', path: '~' }) }, task: { kind: 'none' },
    } as unknown as Session
    const sounds: string[] = []
    // SAFETY: a settled turn reads only these members of the reducer's dependencies.
    const reducer = new SessionEventReducer({
      sessions: { byId: { [SESSION]: session } },
      registry: { tabs: {}, sessionFor: () => session, tabIdsBySession: new Map() },
      settings: { rateLimitBehavior: 'ask' },
      tasksStore: {},
      workStreamTracker: { sweep: () => {}, beginWorkStream: () => {} },
      onTurnSettled: () => {},
      refreshTurnSnapshots: () => {},
      isSessionVisible: () => false,
      publishSessionViewed: () => {},
      closePlanModal: () => {},
      playNotificationIfHidden: (_sessionId: string, trigger: string) => sounds.push(trigger),
      log: () => {},
    } as unknown as ConstructorParameters<typeof SessionEventReducer>[0])
    reducer.apply(SESSION, { type: 'turn_settled', turnId: 'turn-1', outcome: 'completed', settledAt: 0 })
    return sounds
  }

  test('a turn that settles while the session keeps running makes no sound', async () => {
    expect(await setup('running')).toEqual([])
  })

  test('a turn that completes the session sounds once', async () => {
    expect(await setup('completed')).toEqual(['turn_settled'])
  })
})
