import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
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
  dataDir = mkdtempSync(join(tmpdir(), 'solus-control-plane-observability-'))
  process.env.SOLUS_DATA_DIR = dataDir
  controlPlaneModule = await import('@solus/server/control-plane')
  metricsDb = await import('@solus/server/observability/metrics-db')
  db = await import('@solus/server/db')
})

beforeEach(() => {
  metricsDb.getMetricsDb().prepare("DELETE FROM spans WHERE session_id IN ('solus-queue', 'solus-failed')").run()
})

afterEach(() => {
  metricsDb.closeMetricsDb()
  db.closeDb()
  for (const file of ['metrics.db', 'metrics.db-wal', 'metrics.db-shm', 'solus.db', 'solus.db-wal', 'solus.db-shm']) {
    rmSync(join(dataDir, file), { force: true })
  }
})

afterAll(() => {
  metricsDb.closeMetricsDb()
  db.closeDb()
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
  onStart?: () => void

  startRun(request: AgentRunRequest): RunHandle {
    const threadId = request.sessionId ?? `thread-${this.starts + 1}`
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: request.sessionId ?? null,
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
    this.onStart?.()
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

  complete(threadId: string, code: number): void {
    const handle = this.handles.get(threadId)!
    this.emit('normalized', threadId, {
      type: 'task_complete', result: 'done', costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: threadId,
    } satisfies NormalizedEvent)
    handle._resolveRun()
    this.handles.delete(threadId)
    this.emit('exit', threadId, code, null)
  }

  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [...this.pending] }
  cancelSession(sessionId: string): boolean {
    const handle = this.handles.get(sessionId)
    if (!handle) return false
    handle.abortController.abort()
    handle._rejectRun(new Error('Interrupted'))
    this.emit('exit', sessionId, null, 'SIGINT')
    return true
  }
  isSessionRunning(sessionId: string): boolean { return this.handles.has(sessionId) }
  async steerSession(): Promise<null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(agentSessionId: string | null): SessionRunInput {
  return {
    provider: 'codex', agentSessionId, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'gpt-requested', preferredModel: 'gpt-requested', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'ask', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

function turnRows(sessionId: string): Array<{ status: string; origin: string; attrs: string }> {
  return metricsDb.getMetricsDb().prepare("SELECT status, origin, attrs FROM spans WHERE kind = 'turn' AND session_id = ? ORDER BY started_at").all(sessionId) as Array<{ status: string; origin: string; attrs: string }>
}

describe.serial('ControlPlane observability hooks', () => {
  test('threads enqueuedAt through queue drain into queue_wait', async () => {
    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    plane.on('error', () => {})
    const first = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-queue', input: input(null), tools: [],
      options: { prompt: 'first', promptSource: 'typed', skipTaskCreation: true },
    })
    await first.agentSessionId
    const queued = await plane.runTurn({
      target: { kind: 'session', sessionId: 'solus-queue' }, sessionId: 'solus-queue', input: input('thread-1'), tools: [],
      options: { prompt: 'second', promptSource: 'typed', delivery: 'queue', skipTaskCreation: true },
    })
    expect(queued.disposition).toBe('queued')
    const secondStarted = new Promise<void>((resolve) => { backend.onStart = backend.starts === 1 ? resolve : undefined })
    backend.complete('thread-1', 0)
    await first.done
    await secondStarted
    await Promise.resolve()
    backend.complete('thread-1', 0)
    await queued.done

    const turns = turnRows('solus-queue')
    expect(turns).toHaveLength(2)
    expect(JSON.parse(turns[1].attrs)).toMatchObject({ promptSource: 'queued' })
    const queueWait = metricsDb.getMetricsDb().prepare("SELECT duration_ms FROM spans WHERE kind = 'queue_wait' AND session_id = ?").get('solus-queue') as { duration_ms: number }
    expect(queueWait.duration_ms).toBeGreaterThanOrEqual(0)
    plane.shutdown()
  })

  test('a resumed turn records the task its session is bound to', async () => {
    // WHY: only a first dispatch carries a task in its options. Without the
    // session's own binding standing in for later turns, every turn after the
    // first records no task and "what did this task cost" cannot be asked.
    const taskStore = await import('@solus/server/tasks/task-store')
    const { Task } = await import('@solus/server/tasks/task')
    const record = await taskStore.createTask({ title: 'Thread open in insights' })
    await (await Task.byId(record.id)).linkSession('thread-1')

    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    plane.on('error', () => {})
    const resumed = await plane.runTurn({
      target: { kind: 'session', sessionId: 'solus-task' }, sessionId: 'solus-task', input: input('thread-1'), tools: [],
      options: { prompt: 'keep going', promptSource: 'typed', skipTaskCreation: true },
    })
    await resumed.agentSessionId
    backend.complete('thread-1', 0)
    await resumed.done

    const turns = turnRows('solus-task')
    expect(turns).toHaveLength(1)
    expect(JSON.parse(turns[0].attrs)).toMatchObject({
      taskId: record.id,
      taskTitle: 'Thread open in insights',
    })
    plane.shutdown()
  })

  test('a first dispatch keeps one stable task attempt and accepts provider metadata', async () => {
    // WHY: the renderer also links the stable id after session_init. If the
    // server links the provider thread id, one conversation appears twice under
    // its task. Automatic naming still arrives under the provider id, so the
    // same lifecycle must resolve that alias back to the one stable task link.
    const taskSessions = await import('@solus/server/tasks/task-sessions')
    const record = await taskSessions.prepareSessionTask({ prompt: 'Raw first prompt' })
    if (!record) throw new Error('Expected a session-born task')

    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    plane.on('error', () => {})
    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-task', input: input(null), tools: [],
      options: { prompt: 'start', promptSource: 'typed', taskId: record.id, skipTaskCreation: true },
    })
    await lifecycle.agentSessionId
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(taskSessions.taskSessions(record.id)[record.id]).toEqual([
      expect.objectContaining({ sessionId: 'solus-task' }),
    ])
    expect(await taskSessions.updateGeneratedMetadataForSession(
      'thread-1',
      'Generated task title',
      'Generated task description.',
    )).toMatchObject({
      id: record.id,
      title: 'Generated task title',
      body: 'Generated task description.',
    })

    backend.complete('thread-1', 0)
    await lifecycle.done
    plane.shutdown()
  })

  test('records a fulfilled Codex failed turn as error', async () => {
    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    plane.on('error', () => {})
    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-failed', input: input(null), tools: [],
      options: { prompt: 'fail', promptSource: 'typed', skipTaskCreation: true },
    })
    await lifecycle.agentSessionId
    backend.complete('thread-1', 1)
    await lifecycle.done
    expect(turnRows('solus-failed')).toEqual([expect.objectContaining({ status: 'error', origin: 'typed' })])
    plane.shutdown()
  })
})
