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
  dataDir = mkdtempSync(join(tmpdir(), 'solus-control-plane-watch-attach-'))
  process.env.SOLUS_DATA_DIR = dataDir
  controlPlaneModule = await import('@solus/server/control-plane')
  metricsDb = await import('@solus/server/observability/metrics-db')
  db = await import('@solus/server/db')
})

afterEach(() => {
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

  complete(threadId: string): void {
    const handle = this.handles.get(threadId)!
    this.emit('normalized', threadId, {
      type: 'task_complete', result: 'done', costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: threadId,
    } satisfies NormalizedEvent)
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

function input(): SessionRunInput {
  return {
    provider: 'codex', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'gpt-requested', preferredModel: 'gpt-requested', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'ask', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

describe.serial('ControlPlane watchSession runtime attach', () => {
  test('a watch that asks to attach answers with the live runtime in the same call', async () => {
    // WHY: opening a session used to be a watch followed by a bind, two round
    // trips for one question. The watch carries the bind's answer so a client
    // joining a live session pays one.
    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    plane.on('error', () => {})
    const replayed: Array<{ sessionId: string; event: NormalizedEvent; only?: string }> = []
    plane.on('event', (sessionId, event: NormalizedEvent, options?: { only?: string }) => {
      replayed.push({ sessionId, event, only: options?.only })
    })

    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-watch-attach', input: input(), tools: [],
      options: { prompt: 'inspect it', promptSource: 'typed', skipTaskCreation: true },
    })
    await lifecycle.agentSessionId
    await Promise.resolve()

    const plainWatch = plane.watchSession({ sessionId: 'solus-watch-attach', agentSessionId: 'thread-1' }, 'client-plain')
    expect(plainWatch).toEqual({ sessionId: 'solus-watch-attach' })

    const attached = plane.watchSession(
      { sessionId: 'solus-watch-attach', agentSessionId: 'thread-1', attachRuntime: true },
      'client-attached',
    )
    expect(attached.sessionId).toBe('solus-watch-attach')
    expect(attached.runtime).toMatchObject({
      status: 'running',
      permissionMode: 'ask',
      modelConfig: { modelId: 'gpt-requested', reasoningEffort: 'medium' },
    })
    // Both clients are watching: the attach did not replace the watch.
    expect(plane.clientsWatching('solus-watch-attach')).toEqual(expect.arrayContaining(['client-plain', 'client-attached']))

    backend.complete('thread-1')
    await lifecycle.done
    const afterExit = plane.watchSession(
      { sessionId: 'solus-watch-attach', agentSessionId: 'thread-1', attachRuntime: true },
      'client-late',
    )
    // Asked and answered: no runtime is a null, never an absent field.
    expect(afterExit.runtime).toBeNull()
    plane.shutdown()
  })
})
