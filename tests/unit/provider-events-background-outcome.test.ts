import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { EventEmitter } from 'node:events'
import type { BackendSession, NormalizedEvent, SessionStatus } from '@solus/contracts/types'
import type { AgentBackend } from '@solus/server/execution/agents/agent-backend'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let ProviderEvents: typeof import('@solus/server/execution/sessions/provider-events')['ProviderEvents']
beforeAll(async () => {
  ;({ ProviderEvents } = await import('@solus/server/execution/sessions/provider-events'))
})

// WHY: a Codex turn can end, completed or failed, while work it started (a
// native sub-agent, a command) still runs. The session must show that work
// and offer Stop ('background'), free its queue at once, report a failure
// once, and settle once when the work ends: as 'failed' after a failed turn,
// 'completed' after a completed one.

const SESSION = 'solus-session'
const THREAD = 'codex-thread'

/** The control plane state the provider events read, and nothing else. */
function setup() {
  const statuses: SessionStatus[] = []
  const errors: string[] = []
  const queueRuns: string[] = []
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
    },
    inputRequests: { expirePendingInput: () => {}, stampTurnAuthor: () => {} },
    sessionEmitter: { onEvent: () => {}, recordTerminal: () => {} },
    rateLimitPark: { currentRateLimitEvent: () => null },
    handoffs: { handoffCarry: { settle: () => {} } },
    scheduler: { hasReadyQueuedRequest: () => false, processQueueForSession: (sessionId: string) => queueRuns.push(sessionId) },
    flushPendingSession: () => {},
    emitError: (sessionId: string) => errors.push(sessionId),
    publish: () => {},
    reportToActiveRun: () => {},
  }
  let backgroundWork = false
  const backend = Object.assign(new EventEmitter(), {
    id: 'codex' as const,
    getSessionHandle: () => undefined,
    getPendingHandles: () => [],
    hasBackgroundTasks: () => backgroundWork,
    getEnrichedError: () => ({ message: 'Codex run failed', stderrTail: [], stdoutTail: [], exitCode: 1, elapsedMs: 0, toolCallCount: 0, sawPermissionRequest: false, permissionDenials: [] }),
  })
  // SAFETY: the provider events read only the members above in these paths.
  new ProviderEvents(runtime as unknown as SessionRuntime).wire(backend as unknown as AgentBackend)
  const emit = (event: NormalizedEvent) => backend.emit('normalized', THREAD, event)
  /** The turn ends with `code` while a child it started still works. */
  const endTurnWithWork = (code: 0 | 1) => {
    emit({ type: 'background_task_started', taskId: 'child', toolUseId: 'spawn-1' })
    backgroundWork = true
    backend.emit('exit', THREAD, code, null)
  }
  const settleWork = (status: 'completed' | 'failed' | 'stopped' | 'killed') => {
    backgroundWork = false
    emit({ type: 'background_task_settled', taskId: 'child', toolUseId: 'spawn-1', status })
  }
  return { backend, activeSessions, statuses, errors, queueRuns, endTurnWithWork, settleWork }
}

describe('a Codex turn that ends while its work still runs', () => {
  test('a failed turn reports the failure now, waits in background, and settles as failed once the work ends', () => {
    const { backend, activeSessions, statuses, errors, queueRuns, endTurnWithWork, settleWork } = setup()
    endTurnWithWork(1)

    expect(statuses).toEqual(['background'])
    expect(errors).toEqual([SESSION])
    // The queue is free: a waiting prompt runs as the next turn.
    expect(queueRuns).toEqual([SESSION])
    expect(activeSessions.has(SESSION)).toBe(true)

    settleWork('completed')
    expect(statuses).toEqual(['background'])
    backend.emit('background-work-ended', THREAD)

    expect(statuses).toEqual(['background', 'failed'])
    expect(errors).toEqual([SESSION])
    expect(activeSessions.has(SESSION)).toBe(false)
    backend.emit('background-work-ended', THREAD)
    expect(statuses).toEqual(['background', 'failed'])
  })

  test('a completed turn settles as completed once the work ends', () => {
    const { backend, statuses, errors, endTurnWithWork, settleWork } = setup()
    endTurnWithWork(0)
    settleWork('completed')
    backend.emit('background-work-ended', THREAD)
    expect(statuses).toEqual(['background', 'completed'])
    expect(errors).toEqual([])
  })

  test('stopping the work after a failed turn settles it as failed', () => {
    const { statuses, endTurnWithWork, settleWork } = setup()
    endTurnWithWork(1)
    settleWork('stopped')
    expect(statuses).toEqual(['background', 'failed'])
  })

  test('a failed turn with nothing left running settles as failed at once, as before', () => {
    const { backend, activeSessions, statuses, errors } = setup()
    backend.emit('exit', THREAD, 1, null)
    expect(statuses).toEqual(['failed'])
    expect(errors).toEqual([SESSION])
    expect(activeSessions.has(SESSION)).toBe(false)
  })

  test('a later turn clears the failure: its own outcome settles the next wait', () => {
    const { backend, activeSessions, statuses, endTurnWithWork, settleWork } = setup()
    endTurnWithWork(1)
    // A prompt runs as the next turn, which completes with the work still running.
    activeSessions.get(SESSION)!.status = 'running'
    backend.emit('exit', THREAD, 0, null)
    settleWork('completed')
    backend.emit('background-work-ended', THREAD)
    expect(statuses).toEqual(['background', 'background', 'completed'])
  })
})
