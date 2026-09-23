import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'

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
  dataDir = mkdtempSync(join(tmpdir(), 'solus-control-plane-background-status-'))
  process.env.SOLUS_DATA_DIR = dataDir
  controlPlaneModule = await import('@solus/server/control-plane')
  metricsDb = await import('@solus/server/observability/metrics-db')
  db = await import('@solus/server/db')
})

afterEach(() => {
  mock.restore()
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

const THREAD_ID = 'thread-background'

/** One Claude query that stays open, as the SDK keeps it while a background
 *  task runs: every later prompt must arrive through `steerSession`. */
class Backend extends EventEmitter implements AgentBackend {
  readonly id = 'claude-code' as const
  readonly metadata: AgentMetadata = { id: 'claude-code', label: 'Claude', models: [], defaultModel: 'claude-test' }
  readonly permissions = new Permissions()
  readonly handles = new Map<string, RunHandle>()
  starts = 0
  steered: string[] = []
  cancelled: string[] = []

  startRun(_request: AgentRunRequest): RunHandle {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: THREAD_ID,
      persistence: 'session',
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>((res, rej) => { resolve = res; reject = rej }),
      _resolveRun: resolve,
      _rejectRun: reject,
    }
    this.starts++
    this.handles.set(THREAD_ID, handle)
    queueMicrotask(() => this.init())
    return handle
  }

  init(): void {
    this.emit('normalized', THREAD_ID, {
      type: 'session_init', sessionId: THREAD_ID, model: 'claude-test', skills: [],
    } satisfies NormalizedEvent)
  }

  startTask(taskId: string): void {
    this.emit('normalized', THREAD_ID, { type: 'background_task_started', taskId } satisfies NormalizedEvent)
  }

  settleTask(taskId: string): void {
    this.emit('normalized', THREAD_ID, { type: 'background_task_settled', taskId, status: 'completed' } satisfies NormalizedEvent)
  }

  result(): void {
    this.emit('normalized', THREAD_ID, {
      type: 'task_complete', result: 'done', costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: THREAD_ID,
    } satisfies NormalizedEvent)
  }

  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(sessionId: string): boolean {
    this.cancelled.push(sessionId)
    return this.handles.has(sessionId)
  }
  isSessionRunning(sessionId: string): boolean { return this.handles.has(sessionId) }
  async steerSession(sessionId: string, options: { prompt: string }): Promise<RunHandle | null> {
    this.steered.push(options.prompt)
    return this.handles.get(sessionId) ?? null
  }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

const SESSION_ID = 'solus-background-status'

function input(): SessionRunInput {
  return {
    provider: 'claude-code', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'claude-test', preferredModel: 'claude-test', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'ask', rateLimitBehavior: 'ask', extraInstructions: '',
  }
}

/** Queued settlements are published on a microtask. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A turn that started a background task (a `wrangler tail`, a dev server) and
 *  then ended its turn while that task still runs. */
async function endTurnWithTaskRunning() {
  const backend = new Backend()
  const plane = new controlPlaneModule.ControlPlane(new Map([['claude-code', backend]]))
  plane.on('error', () => {})
  const events: NormalizedEvent[] = []
  plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

  const lifecycle = await plane.runTurn({
    target: { kind: 'new-session' }, sessionId: SESSION_ID, input: input(), tools: [],
    options: { prompt: 'tail the logs', promptSource: 'typed', skipTaskCreation: true },
  })
  lifecycle.done.catch(() => {})
  await lifecycle.agentSessionId
  await flush()

  backend.startTask('tail')
  backend.result()
  await flush()
  return { backend, plane, events }
}

const statuses = (events: NormalizedEvent[]) =>
  events.flatMap((event) => (event.type === 'status_change' ? [event.status] : []))
const settlements = (events: NormalizedEvent[]) =>
  events.flatMap((event) => (event.type === 'turn_settled' ? [event] : []))

describe.serial('ControlPlane background status', () => {
  test('a turn that ends with a background task running settles instead of holding running', async () => {
    const { plane, events } = await endTurnWithTaskRunning()
    try {
      expect(statuses(events).at(-1)).toBe('background')
      // The turn is finished for the user: clients mark it unread and notify.
      expect(settlements(events)).toEqual([expect.objectContaining({ outcome: 'completed' })])
      expect(plane.isSessionBusy(SESSION_ID)).toBe(false)
    } finally {
      plane.shutdown()
    }
  })

  test('a prompt sent in background goes into the open query, never a second run', async () => {
    const { backend, plane } = await endTurnWithTaskRunning()
    try {
      const lifecycle = await plane.runTurn({
        target: { kind: 'session', sessionId: SESSION_ID }, sessionId: SESSION_ID, input: input(), tools: [],
        // Even an explicit queue: the turn is over, so nothing would drain it.
        options: { prompt: 'what did the tail show?', promptSource: 'typed', delivery: 'queue', skipTaskCreation: true },
      })
      expect(lifecycle.disposition).toBe('steered')
      expect(backend.steered).toEqual(['what did the tail show?'])
      expect(backend.starts).toBe(1)
    } finally {
      plane.shutdown()
    }
  })

  test('the agent turn that follows a background turn settles on its own', async () => {
    const { backend, plane, events } = await endTurnWithTaskRunning()
    try {
      // The SDK resumes the agent in the same query when the task settles.
      backend.settleTask('tail')
      backend.init()
      backend.result()
      await flush()

      expect(statuses(events).slice(-2)).toEqual(['running', 'completed'])
      const [first, second] = settlements(events)
      expect(second?.outcome).toBe('completed')
      expect(second?.turnId).not.toBe(first?.turnId)
    } finally {
      plane.shutdown()
    }
  })

  test('Stop in background cancels the query that keeps the task alive', async () => {
    const { backend, plane, events } = await endTurnWithTaskRunning()
    try {
      expect(plane.stopSession(SESSION_ID)).toBe(true)
      expect(backend.cancelled).toEqual([THREAD_ID])
      expect(statuses(events).at(-1)).toBe('interrupted')
    } finally {
      plane.shutdown()
    }
  })
})
