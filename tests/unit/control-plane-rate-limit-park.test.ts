import { afterAll, afterEach, beforeAll, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import { FIVE_HOUR_WINDOW_MINS } from '@solus/contracts/types'
import type { AgentMetadata, IpcContext, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ControlPlaneModule = typeof import('@solus/server/control-plane')
type MetricsDbModule = typeof import('@solus/server/observability/metrics-db')
type DbModule = typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let controlPlaneModule: ControlPlaneModule
let metricsDb: MetricsDbModule
let db: DbModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-control-plane-rate-limit-park-'))
  process.env.SOLUS_DATA_DIR = dataDir
  controlPlaneModule = await import('@solus/server/control-plane')
  metricsDb = await import('@solus/server/observability/metrics-db')
  db = await import('@solus/server/db')
})

afterEach(() => {
  setSystemTime()
  metricsDb.closeMetricsDb()
  db.closeDb()
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

class Permissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

class Backend extends EventEmitter implements AgentBackend {
  readonly id = 'codex' as const
  readonly metadata: AgentMetadata = { id: 'codex', label: 'Codex', models: [], defaultModel: 'gpt-test' }
  readonly permissions = new Permissions()
  readonly handles = new Map<string, RunHandle>()
  readonly pending = new Set<RunHandle>()
  starts = 0
  private startWaiters: Array<() => void> = []

  /** Resolves the next time the provider is asked to start a run, so a test can
   *  await the dispatch itself rather than a duration it hopes is long enough. */
  nextStart(): Promise<void> {
    return new Promise((resolve) => { this.startWaiters.push(resolve) })
  }

  startRun(request: AgentRunRequest): RunHandle {
    const threadId = (request.conversation?.kind === 'resume' ? request.conversation.threadId : null) ?? `thread-${this.starts + 1}`
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: (request.conversation?.kind === 'resume' ? request.conversation.threadId : null) ?? null,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>((res, rej) => { resolve = res; reject = rej }),
      _resolveRun: resolve,
      _rejectRun: reject,
    }
    this.pending.add(handle)
    this.starts++
    for (const resolve of this.startWaiters.splice(0)) resolve()
    queueMicrotask(() => {
      handle.agentSessionId = threadId
      this.pending.delete(handle)
      this.handles.set(threadId, handle)
      this.emit('normalized', threadId, {
        type: 'session_init', sessionId: threadId, model: 'gpt-executed', skills: [],
      } satisfies NormalizedEvent)
    })
    return handle
  }

  /** Feed the fallback cache before a terminal limit that omits its reset. */
  reportWindow(threadId: string, resetsAt: number | null): void {
    this.emit('normalized', threadId, {
      type: 'usage_limits',
      windows: [{ windowDurationMins: FIVE_HOUR_WINDOW_MINS, usedPercent: 100, resetsAt }],
    } satisfies NormalizedEvent)
  }

  /** The provider says the account is spent, then the run ends — the exact
   *  shape that parks the session instead of settling it. */
  rateLimit(threadId: string): void {
    this.emit('normalized', threadId, {
      type: 'rate_limit', status: 'limited', resetsAt: null, rateLimitType: 'Codex 5h', isUsingOverage: false,
      windowDurationMins: FIVE_HOUR_WINDOW_MINS,
    } satisfies NormalizedEvent)
    const handle = this.handles.get(threadId)!
    handle._resolveRun()
    this.handles.delete(threadId)
    this.emit('exit', threadId, 0, null)
  }

  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [...this.pending] }
  cancelSession(): boolean { return false }
  isSessionRunning(sessionId: string): boolean { return this.handles.has(sessionId) }
  async steerSession(): Promise<null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

const SESSION_ID = 'solus-rate-limit-park'

function ctx(): IpcContext {
  return { session: { sessionId: SESSION_ID } } as IpcContext
}

function input(rateLimitBehavior: 'ask' | 'queue'): SessionRunInput {
  return {
    provider: 'codex', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'gpt-requested', preferredModel: 'gpt-requested', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'ask', rateLimitBehavior, extraInstructions: '',
  }
}

interface Parked {
  backend: Backend
  plane: InstanceType<ControlPlaneModule['ControlPlane']>
  events: NormalizedEvent[]
  /** The watchdog sweep, driven to its miss limit rather than waited out. */
  sweepWatchdog(): void
  /** Run the captured release callback at its deadline without a wall-clock wait. */
  settleRelease(): Promise<void>
}

/** A session stopped by a rate limit and left parked, which is where all three
 *  of these behaviours start. `resetsInMs` of null is a limit whose reset the
 *  provider never stated: no countdown, no timer, released only by hand. */
async function park(
  resetsInMs: number | null,
  rateLimitBehavior: 'ask' | 'queue' = 'ask',
): Promise<Parked> {
  const backend = new Backend()
  const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
  plane.on('error', () => {})
  const events: NormalizedEvent[] = []
  plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

  const lifecycle = await plane.runTurn({
    target: { kind: 'new-session' }, sessionId: SESSION_ID, input: input(rateLimitBehavior), tools: [],
    options: { prompt: 'ship it', promptSource: 'typed', skipTaskCreation: true },
  })
  lifecycle.done.catch(() => {})
  await lifecycle.agentSessionId
  await Promise.resolve()

  const resetsAt = resetsInMs === null ? null : Date.now() + resetsInMs
  backend.reportWindow('thread-1', resetsAt)
  const timerSpy = spyOn(globalThis, 'setTimeout')
  backend.rateLimit('thread-1')
  const releaseCallback = timerSpy.mock.calls.find(([, delay]) => typeof delay === 'number' && delay >= 120_000)?.[0]
  timerSpy.mockRestore()
  await Promise.resolve()

  // Codex retries two minutes after the raw provider reset.
  const releaseAt = resetsAt === null ? null : (Math.ceil(resetsAt / 1000) + 120) * 1000
  const watchdog = plane as unknown as { _checkActiveRuns(): void }
  return {
    backend,
    plane,
    events,
    sweepWatchdog: () => { watchdog._checkActiveRuns(); watchdog._checkActiveRuns() },
    settleRelease: async () => {
      if (releaseAt !== null) {
        setSystemTime(new Date(releaseAt))
        if (typeof releaseCallback !== 'function') throw new Error('Missing rate-limit release timer')
        releaseCallback()
      }
      await Promise.resolve()
    },
  }
}

function statusOf(plane: Parked['plane'], clientId: string): string | null {
  const watch = plane.watchSession(
    { sessionId: SESSION_ID, agentSessionId: 'thread-1', attachRuntime: true },
    clientId,
  )
  return watch.runtime?.status ?? null
}

describe.serial('ControlPlane rate-limit park teardown', () => {
  test('queuing an unknown reset waits for an explicit send', async () => {
    const { backend, plane, events } = await park(null)
    try {
      expect(plane.resolveRateLimit(ctx(), 'wait')).toBe(true)
      // There must be no timer that can release this prompt on its own.
      const timers = plane as unknown as { rateLimitTimers: Map<string, ReturnType<typeof setTimeout>> }
      expect(timers.rateLimitTimers.has(SESSION_ID)).toBe(false)
      expect(backend.starts).toBe(1)
      expect(events.filter((event) => event.type === 'rate_limit_resolved')).toEqual([])
      const dispatched = backend.nextStart()
      expect(plane.resolveRateLimit(ctx(), 'send_now')).toBe(true)
      await dispatched
      expect(backend.starts).toBe(2)
    } finally {
      plane.shutdown()
    }
  })

  test('direct resets survive unsupported windows and cache refreshes keep retry policy stable', () => {
    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    const prepare = plane as unknown as {
      _prepareRateLimit(agentId: 'codex' | 'claude-code', event: Extract<NormalizedEvent, { type: 'rate_limit' }>): Extract<NormalizedEvent, { type: 'rate_limit' }>
    }
    const reset = Math.ceil(Date.now() / 1000) + 3600
    const event: Extract<NormalizedEvent, { type: 'rate_limit' }> = {
      type: 'rate_limit', status: 'limited', resetsAt: reset, rateLimitType: '1h', windowDurationMins: 60,
    }
    try {
      expect(prepare._prepareRateLimit('codex', event).resetsAt).toBe(reset + 120)
      expect(prepare._prepareRateLimit('claude-code', event).resetsAt).toBe(reset)
      plane.usageLimits.applyWindows('codex', [{windowDurationMins: 300, usedPercent: 100, resetsAt: reset * 1000}])
      const missing = { ...event, resetsAt: null, windowDurationMins: 300 }
      expect(prepare._prepareRateLimit('codex', missing).resetsAt).toBe(reset + 120)
      plane.usageLimits.apply({ provider: 'codex', fiveHour: { usedPercent: 100, resetsAt: reset * 1000, resetsLabel: null }, weekly: null, planType: null, fetchedAt: Date.now(), stale: false })
      expect(prepare._prepareRateLimit('codex', missing).resetsAt).toBe(reset + 120)
      expect(plane.usageLimits.get('codex')?.fiveHour?.resetsAt).toBe(reset * 1000)
    } finally {
      plane.shutdown()
    }
  })

  test('resolving a rate limit with nothing queued retires the parked session', async () => {
    // WHY: a run that ends on a rate limit keeps its session record so the held
    // turn can resume at release, and the run watchdog exempts it only while the
    // limit is parked. Stop & discard clears the limit and drops the status to
    // `idle`, and used to leave the record behind — so a minute later the
    // watchdog found a session with no provider run, declared it dead, and the
    // sidebar showed a permanent error on a session the user had simply stopped.
    const { plane, events, sweepWatchdog } = await park(60_000)
    expect(statusOf(plane, 'client-parked')).toBe('rate_limited')

    expect(plane.resolveRateLimit(ctx(), 'stop')).toBe(true)

    sweepWatchdog()
    expect(events.filter((event) => event.type === 'session_dead')).toEqual([])
    plane.shutdown()
  })

  test('a window reopening keeps the held prompt and the question it belongs to', async () => {
    // WHY: the card promises that nothing runs until the user chooses. The
    // release timer used to fire at the reset and resolve the limit for them,
    // which retired the card and discarded the prompt it was holding. A window
    // reopening is not an answer — the prompt waits, and still sends.
    const { backend, plane, events, settleRelease, sweepWatchdog } = await park(1)
    await settleRelease()

    expect(statusOf(plane, 'client-reopened')).toBe('rate_limited')
    expect(events.filter((event) => event.type === 'rate_limit_resolved')).toEqual([])
    sweepWatchdog()
    expect(events.filter((event) => event.type === 'session_dead')).toEqual([])

    // The answer, whenever it comes, still has a prompt to send.
    const dispatched = backend.nextStart()
    expect(plane.resolveRateLimit(ctx(), 'send_now')).toBe(true)
    await dispatched
    expect(backend.starts).toBe(2)
    plane.shutdown()
  })

  test('cancelling the last prompt a limit holds settles the session', async () => {
    // WHY: the queue strategy parks the prompt, and removing it is the user
    // saying the limit no longer holds anything. Nothing else would say so: the
    // session kept the `rate_limited` status, and the card its countdown, until
    // some unrelated turn moved it.
    const { plane, events, sweepWatchdog } = await park(60_000, 'queue')
    const queued = events.find((event) => event.type === 'prompt_queued')
    expect(queued).toBeDefined()

    expect(plane.cancelQueuedPrompt(ctx(), (queued as { queueId: string }).queueId)).toBe(true)

    expect(statusOf(plane, 'client-cancelled')).toBeNull()
    expect(events.filter((event) => event.type === 'rate_limit_resolved')).toHaveLength(1)
    sweepWatchdog()
    expect(events.filter((event) => event.type === 'session_dead')).toEqual([])
    plane.shutdown()
  })
})
