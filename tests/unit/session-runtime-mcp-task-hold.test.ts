import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { HOST_ACTOR } from '@solus/server/admission/actor'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '@solus/server/execution/agents/agent-runner'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * A live MCP task holds its session in 'background' with no provider run, as
 * the sessions it sent work to do (docs/background-work.md,
 * docs/plans/mcp-first-class.md §12.5). Each status path that knows "this
 * session has no run by design" must know this hold too.
 */

type SessionRuntimeModule = typeof import('@solus/server/execution/session-runtime')
type MetricsDbModule = typeof import('@solus/server/data/insights/metrics-db')
type DbModule = typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let sessionRuntimeModule: SessionRuntimeModule
let metricsDb: MetricsDbModule
let db: DbModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-mcp-task-hold-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionRuntimeModule = await import('@solus/server/execution/session-runtime')
  metricsDb = await import('@solus/server/data/insights/metrics-db')
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

const THREAD_ID = 'thread-mcp-task'
const SESSION_ID = 'solus-mcp-task-hold'

/** A provider whose turn ends and whose run exits, as Codex's does: nothing of the provider is left running. */
class Backend extends EventEmitter implements AgentBackend {
  readonly id = 'codex' as const
  readonly metadata: AgentMetadata = { id: 'codex', label: 'Codex', models: [], defaultModel: 'codex-test' }
  readonly permissions = new Permissions()
  readonly handles = new Map<string, RunHandle>()
  cancelled: string[] = []

  startRun(_request: AgentRunRequest, sessionState?: AgentRunSessionState): RunHandle {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: THREAD_ID,
      sessionId: sessionState?.sessionId,
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
    this.handles.set(THREAD_ID, handle)
    queueMicrotask(() => this.emit('normalized', THREAD_ID, { type: 'session_init', sessionId: THREAD_ID, model: 'codex-test', skills: [] } satisfies NormalizedEvent))
    return handle
  }

  endTurn(): void {
    this.emit('normalized', THREAD_ID, {
      type: 'task_complete', result: 'the export runs in the background', costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: THREAD_ID,
    } satisfies NormalizedEvent)
    this.handles.delete(THREAD_ID)
    this.emit('exit', THREAD_ID, 0, null)
  }

  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(sessionId: string): boolean {
    this.cancelled.push(sessionId)
    return false
  }
  hasBackgroundTasks(): boolean { return false }
  isSessionRunning(sessionId: string): boolean { return this.handles.has(sessionId) }
  async steerSession(): Promise<RunHandle | null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(): SessionRunInput {
  return {
    provider: 'codex', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null,
    model: 'codex-test', preferredModel: 'codex-test', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'ask', extraInstructions: '',
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A turn that started an MCP task, which outlived the turn: the task holds the session. */
async function endTurnWithMcpTaskLive() {
  const backend = new Backend()
  const plane = new sessionRuntimeModule.SessionRuntime(new Map([['codex', backend]]))
  plane.on('error', () => {})
  const events: NormalizedEvent[] = []
  plane.on('event', (_sessionId: string, event: NormalizedEvent, to?: { only?: string }) => { if (!to?.only) events.push(event) })
  const liveTasks = new Set<string>(['export'])
  plane.useMcpTaskHolds((sessionId) => sessionId === SESSION_ID && liveTasks.size > 0)

  const lifecycle = await plane.runTurn({
    target: { kind: 'new-session' }, sessionId: SESSION_ID, input: input(), tools: [],
    options: { prompt: 'export the report', promptSource: 'typed' },
  })
  lifecycle.done.catch(() => {})
  await lifecycle.agentSessionId
  await flush()
  backend.endTurn()
  await flush()
  /** The task ended, and its owner says so, as `McpTasks.end` does. */
  const endTask = () => {
    liveTasks.clear()
    plane.providerEvents.endBackgroundWait(SESSION_ID)
  }
  return { backend, plane, events, endTask }
}

const statuses = (events: NormalizedEvent[]) =>
  events.flatMap((event) => (event.type === 'status_change' ? [event.status] : []))

describe.serial('a live MCP task holds its session outside the run', () => {
  test('the turn settles into background while the task runs', async () => {
    const { plane, events } = await endTurnWithMcpTaskLive()
    try {
      expect(statuses(events).at(-1)).toBe('background')
      expect(plane.statuses.holdsOutsideRun(SESSION_ID)).toBe(true)
    } finally {
      plane.shutdown()
    }
  })

  test('the run watchdog does not mark a watched session dead', async () => {
    // WHY: the session has no provider run by design. A watched session with
    // no run counts misses, so two ticks ended the MCP task's session as dead.
    const { plane, events } = await endTurnWithMcpTaskLive()
    try {
      plane.watchers.watchSession({ sessionId: SESSION_ID }, 'client')
      plane.statuses.checkActiveRuns()
      plane.statuses.checkActiveRuns()
      expect(statuses(events)).not.toContain('dead')
      expect(plane.activeSessions.get(SESSION_ID)?.status).toBe('background')
    } finally {
      plane.shutdown()
    }
  })

  test('a client join keeps the session record, and the end of the task settles it as completed', async () => {
    // WHY: a join that deleted the record left nothing for the end of the
    // task to settle, so the session stayed 'background' in every client.
    const { plane, events, endTask } = await endTurnWithMcpTaskLive()
    try {
      const watched = plane.watchers.watchSession({ sessionId: SESSION_ID, attachRuntime: true }, 'client')
      expect(watched.runtime?.status).toBe('background')
      expect(plane.activeSessions.has(SESSION_ID)).toBe(true)

      endTask()
      await flush()
      expect(statuses(events).at(-1)).toBe('completed')
      expect(plane.activeSessions.has(SESSION_ID)).toBe(false)
    } finally {
      plane.shutdown()
    }
  })

  test('the end of the last task settles the session; one still live keeps it waiting', async () => {
    const { plane, events } = await endTurnWithMcpTaskLive()
    try {
      // The orchestrator's own wait ending does not release a session that an MCP task holds.
      plane.providerEvents.endBackgroundWait(SESSION_ID)
      expect(statuses(events).at(-1)).toBe('background')
    } finally {
      plane.shutdown()
    }
  })

  test('Stop keeps its present behavior: it does not end the wait or touch the task', async () => {
    // The Stop rule for work that can wake a session later is not chosen yet
    // (reuse audit R6). Until it is, Stop and the background row's Stop leave
    // an MCP task, and the session that it holds, as they are.
    const { plane, events } = await endTurnWithMcpTaskLive()
    try {
      expect(plane.stopSession(SESSION_ID, HOST_ACTOR)).toBe(false)
      expect(await plane.stopBackgroundTasks(SESSION_ID)).toBe(false)
      expect(statuses(events)).not.toContain('interrupted')
      expect(plane.activeSessions.get(SESSION_ID)?.status).toBe('background')
    } finally {
      plane.shutdown()
    }
  })

  test('a session with no MCP task and no run is not held', async () => {
    const { plane, endTask } = await endTurnWithMcpTaskLive()
    try {
      endTask()
      await flush()
      expect(plane.statuses.holdsOutsideRun(SESSION_ID)).toBe(false)
      expect(plane.statuses.waitsOutsideRun(SESSION_ID)).toBe(false)
    } finally {
      plane.shutdown()
    }
  })
})
