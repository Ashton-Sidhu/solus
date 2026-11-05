import { afterAll, afterEach, beforeAll, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { HOST_ACTOR } from '@solus/server/admission/actor'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { FIVE_HOUR_WINDOW_MINS } from '@solus/contracts/types'
import type { AgentId, AgentMetadata, IpcContext, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type SessionRuntimeModule = typeof import('@solus/server/execution/session-runtime')
type MetricsDbModule = typeof import('@solus/server/data/insights/metrics-db')
type DbModule = typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let sessionRuntimeModule: SessionRuntimeModule
let metricsDb: MetricsDbModule
let db: DbModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-verify-24634-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionRuntimeModule = await import('@solus/server/execution/session-runtime')
  metricsDb = await import('@solus/server/data/insights/metrics-db')
  db = await import('@solus/server/db')
})

afterEach(() => {
  mock.restore()
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
  readonly metadata: AgentMetadata
  readonly requests: AgentRunRequest[] = []
  constructor(readonly id: 'codex' | 'claude-code' = 'codex') {
    super()
    this.metadata = { id, label: id, models: [], defaultModel: 'gpt-test' }
  }
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
    this.requests.push(request)
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
    setTimeout(() => {
      handle.agentSessionId = threadId
      this.pending.delete(handle)
      this.handles.set(threadId, handle)
      this.emit('normalized', threadId, {
        type: 'session_init', sessionId: threadId, model: 'gpt-executed', skills: [],
      } satisfies NormalizedEvent)
    }, 5)
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
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null,
    model: 'gpt-requested', preferredModel: 'gpt-requested', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior, extraInstructions: '',
  }
}

interface Parked {
  backend: Backend
  plane: InstanceType<SessionRuntimeModule['SessionRuntime']>
  events: NormalizedEvent[]
  releaseDelay: number | undefined
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
  promptSource: 'typed' | 'agent' | 'automation' = 'typed',
  otherProvider?: Backend,
): Promise<Parked> {
  const backend = new Backend()
  const backends = new Map<AgentId, AgentBackend>([['codex', backend]])
  if (otherProvider) backends.set(otherProvider.id, otherProvider)
  const plane = new sessionRuntimeModule.SessionRuntime(backends, {
    buildHandoff: async (oldSessionId) => ({ transcriptFilePath: `/tmp/${oldSessionId}.md`, reasoningFilePath: null }),
  })
  plane.on('error', () => {})
  const events: NormalizedEvent[] = []
  plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

  const lifecycle = await plane.runTurn({
    target: { kind: 'new-session' }, sessionId: SESSION_ID, input: input(rateLimitBehavior), tools: [],
    options: { prompt: 'ship it', promptSource },
  })
  lifecycle.done.catch(() => {})
  await lifecycle.agentSessionId
  await Bun.sleep(20)

  const resetsAt = resetsInMs === null ? null : Date.now() + resetsInMs
  backend.reportWindow('thread-1', resetsAt)
  const timerSpy = spyOn(globalThis, 'setTimeout')
  backend.rateLimit('thread-1')
  const releaseTimer = timerSpy.mock.calls.find(([, delay]) => typeof delay === 'number' && delay >= 120_000)
  const releaseCallback = releaseTimer?.[0]
  timerSpy.mockRestore()
  await Promise.resolve()

  // Codex retries two minutes after the raw provider reset.
  const releaseAt = resetsAt === null ? null : (Math.ceil(resetsAt / 1000) + 120) * 1000
  return {
    backend,
    plane,
    events,
    releaseDelay: releaseTimer?.[1],
    sweepWatchdog: () => { plane.statuses.checkActiveRuns(); plane.statuses.checkActiveRuns() },
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
  const watch = plane.watchers.watchSession(
    { sessionId: SESSION_ID, attachRuntime: true },
    clientId,
  )
  return watch.runtime?.status ?? null
}

describe.serial('#24634 Stop and a rate limit', () => {
  test('Stop on a parked session whose prompt is queued for the reset: it does not resume at the reset', async () => {
    const parked = await park(60_000, 'queue')
    try {
      expect(parked.events.some((event) => event.type === 'prompt_queued')).toBe(true)
      const stopped = parked.plane.stopSession(SESSION_ID, HOST_ACTOR)
      const next = parked.backend.nextStart()
      await parked.settleRelease()
      await Promise.race([next, Bun.sleep(50)])
      // Stop ends the park: the queued prompt does not resume at the reset.
      expect({ stopped, starts: parked.backend.starts }).toEqual({ stopped: true, starts: 1 })
    } finally {
      parked.plane.shutdown()
    }
  })

  test('a limit that lands after Stop does not park or re-queue the stopped prompt', async () => {
    const backend = new Backend()
    backend.cancelSession = (threadId: string) => { backend.handles.get(threadId)?.abortController.abort(); return backend.handles.has(threadId) }
    const plane = new sessionRuntimeModule.SessionRuntime(new Map<AgentId, AgentBackend>([['codex', backend]]))
    plane.on('error', () => {})
    const statuses: string[] = []
    plane.on('session-status', (change: { status: string }) => { statuses.push(change.status) })
    try {
      const lifecycle = await plane.runTurn({
        target: { kind: 'new-session' }, sessionId: SESSION_ID, input: input('queue'), tools: [],
        options: { prompt: 'ship it', promptSource: 'typed' },
      })
      lifecycle.done.catch(() => {})
      await lifecycle.agentSessionId
      await Bun.sleep(20)
      backend.reportWindow('thread-1', Date.now() + 60_000)
      expect(plane.stopSession(SESSION_ID, HOST_ACTOR)).toBe(true)
      backend.rateLimit('thread-1') // the limit result was already in flight
      await Promise.resolve()
      // Stop wins: the turn settles as interrupted, and nothing waits for the reset.
      expect({ status: statuses.at(-1), queued: plane.scheduler.requestQueue.get(SESSION_ID)?.length ?? 0 })
        .toEqual({ status: 'interrupted', queued: 0 })
      expect(statuses).not.toContain('rate_limited')
    } finally {
      plane.shutdown()
    }
  })
})
