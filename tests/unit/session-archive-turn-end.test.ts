import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '@solus/server/execution/agents/agent-runner'
import type { TurnEnd } from '@solus/server/sync/sessions/session-archive-writer'
import { HOST_ACTOR } from '@solus/server/admission/actor'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let runtime: typeof import('@solus/server/execution/session-runtime')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-archive-turn-end-'))
  process.env.SOLUS_DATA_DIR = dataDir
  runtime = await import('@solus/server/execution/session-runtime')
})

afterAll(async () => {
  ;(await import('@solus/server/data/insights/metrics-db')).closeMetricsDb()
  ;(await import('@solus/server/db')).closeDb()
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

/** A backend whose run reports its provider thread at once and ends when the test says. */
class ThreadBackend extends EventEmitter implements AgentBackend {
  readonly id = 'claude-code' as const
  readonly metadata: AgentMetadata = { id: 'claude-code', label: 'Claude Code', models: [], defaultModel: 'claude-sonnet-5' }
  readonly permissions = new Permissions()
  readonly handles: RunHandle[] = []
  private endRun = () => {}

  constructor(private readonly threadId: string) {
    super()
  }

  startRun(request: AgentRunRequest, sessionState?: AgentRunSessionState): RunHandle {
    const handle: RunHandle = {
      agentSessionId: null,
      sessionId: sessionState?.sessionId,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>((resolve) => { this.endRun = resolve }),
      _resolveRun: () => {},
      _rejectRun: () => {},
    }
    this.handles.push(handle)
    // The provider starts its thread. A run that reports nothing did no work and is not a completed turn.
    queueMicrotask(() => {
      handle.agentSessionId = this.threadId
      this.emit('normalized', this.threadId, { type: 'session_init', sessionId: this.threadId, model: 'claude-opus-5', skills: [] } satisfies NormalizedEvent)
    })
    return handle
  }

  /** The provider process exits. */
  end(): void { this.endRun() }
  getSessionHandle(): RunHandle | undefined { return this.handles.at(-1) }
  getPendingHandles(): RunHandle[] { return [] }
  /** Stop reaches the provider: its run is aborted, and ends when the test says. */
  cancelSession(): boolean {
    this.handles.at(-1)?.abortController.abort()
    return true
  }
  isSessionRunning(): boolean { return false }
  async steerSession(): Promise<null> { return null }
  loadSession(): Promise<never[]> { return Promise.resolve([]) }
  listPlans(): Promise<never[]> { return Promise.resolve([]) }
  loadPlanContent(): Promise<null> { return Promise.resolve(null) }
  listPluginCommands() { return Promise.resolve({ commands: [], skills: [] }) }
  refreshPluginCommands(): Promise<void> { return Promise.resolve() }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(): SessionRunInput {
  return {
    provider: 'claude-code', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null,
    model: 'claude-opus-5', preferredModel: 'claude-opus-5', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

/** Run one turn of a session and answer what the session repository writer is told when it ends. */
async function endedTurn(sessionId: string, beforeEnd: (plane: InstanceType<typeof runtime.SessionRuntime>, backend: ThreadBackend) => void = () => {}): Promise<TurnEnd> {
  const backend = new ThreadBackend(`thread-of-${sessionId}`)
  const plane = new runtime.SessionRuntime(new Map([['claude-code', backend]]))
  plane.on('error', () => {})
  const told = new Promise<TurnEnd>((resolve) => plane.useSessionArchive({ turnEnded: async (turn) => resolve(turn) }))
  const lifecycle = await plane.runTurn({
    target: { kind: 'new-session' }, sessionId, input: input(), tools: [],
    options: { prompt: 'do the work', promptSource: 'typed' },
  })
  void lifecycle.done.catch(() => {})
  await lifecycle.agentSessionId
  beforeEnd(plane, backend)
  backend.end()
  const turn = await told
  plane.shutdown()
  return turn
}

describe('the end of a turn and the session repository', () => {
  // WHY: the session repository is complete only when every turn that ran is
  // handed to its writer, with the thread and the folder the turn ran in.
  // Another host continues the session from exactly these.
  test('a turn that ends is handed to the writer with its thread and its folder', async () => {
    expect(await endedTurn('solus-archive-turn')).toEqual({
      sessionId: 'solus-archive-turn', organizationId: 'local', provider: 'claude-code', threadId: 'thread-of-solus-archive-turn',
      projectPath: process.cwd(), workTree: process.cwd(), partial: false,
    })
  })

  // WHY: a stopped turn left a thread and files that end in the middle of the
  // work. A host that continues from it must know that, so the turn is marked.
  test('a stopped turn is handed to the writer as partial', async () => {
    const turn = await endedTurn('solus-archive-stopped-turn', (plane) => { plane.stopSession('solus-archive-stopped-turn', HOST_ACTOR) })
    expect(turn.partial).toBe(true)
  })
})
