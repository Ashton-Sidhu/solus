import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentId, AgentMetadata, NormalizedEvent, PermissionRequest, QuestionRequest, Session, SessionRunInput, Tab } from '@solus/contracts/types'
import type { Principal } from '@solus/server/admission/principal'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// A pending permission or question is answerable only while the run that asked
// it is alive. When the run ends, the host closes it and every client must learn
// that, so no card keeps an answer button that can only fail.

const previousDataDir = process.env.SOLUS_DATA_DIR
const dataDir = mkdtempSync(join(tmpdir(), 'solus-request-expiry-'))
process.env.SOLUS_DATA_DIR = dataDir

const { SessionRuntime } = await import('@solus/server/execution/session-runtime')
const { registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers')
const { HOST_ACTOR } = await import('@solus/server/admission/actor')
const { withActor } = await import('./helpers/actors')
const { REQUEST_NOT_ANSWERABLE_CODE } = await import('@solus/contracts/types')
const { getAttentionState } = await import('@solus/workspace-ui/lib/sessionUtils')
const { TranscriptModel } = await import('../../apps/mobile/src/features/conversation/lib/transcript-model')
const metricsDb = await import('@solus/server/data/insights/metrics-db')
const db = await import('@solus/server/db')

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
  readonly cleared: string[] = []
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return true }
  respondToQuestion(): boolean { return true }
  clearPendingForSession(sessionId: string): void { this.cleared.push(sessionId) }
  setCurrentSessionId(): void {}
}

class Backend extends EventEmitter implements AgentBackend {
  readonly metadata: AgentMetadata
  readonly permissions = new Permissions()
  readonly handles = new Map<string, RunHandle>()
  starts = 0

  constructor(readonly id: AgentId, readonly threadId: string) {
    super()
    this.metadata = { id, label: id, models: [], defaultModel: 'model-test' }
  }

  startRun(request: AgentRunRequest): RunHandle {
    const threadId = (request.conversation?.kind === 'resume' ? request.conversation.threadId : null) ?? this.threadId
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: null,
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
    this.starts++
    queueMicrotask(() => {
      handle.agentSessionId = threadId
      this.handles.set(threadId, handle)
      this.emit('normalized', threadId, { type: 'session_init', sessionId: threadId, model: 'model-test', skills: [] } satisfies NormalizedEvent)
    })
    return handle
  }

  /** The run is stopped: the provider process ends without an answer. */
  stop(threadId: string): void {
    this.handles.get(threadId)?._resolveRun()
    this.handles.delete(threadId)
    this.emit('exit', threadId, null, 'SIGINT')
  }

  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(): boolean { return false }
  isSessionRunning(sessionId: string): boolean { return this.handles.has(sessionId) }
  async steerSession(): Promise<RunHandle | null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(provider: AgentId): SessionRunInput {
  return {
    provider, agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'model-test', preferredModel: 'model-test', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'This Mac' }

let runs = 0

/** A run that asks a permission, a blocking question, and an async question.
 *  The host database outlives a run, so each run names its own session, thread, and question. */
async function askingRun(provider: AgentId) {
  const run = ++runs
  const sessionId = `asking-${run}`
  const threadId = `thread-${run}`
  const asyncId = `async-${run}`
  const backend = new Backend(provider, threadId)
  const plane = new SessionRuntime(new Map([[provider, backend]]))
  plane.on('error', () => {})
  const events: NormalizedEvent[] = []
  plane.on('event', (_sessionId: string, event: NormalizedEvent) => events.push(event))
  const lifecycle = await plane.runTurn({
    target: { kind: 'new-session' }, sessionId, input: input(provider), tools: [],
    options: { prompt: 'do it', promptSource: 'typed' },
  })
  await lifecycle.agentSessionId
  backend.emit('normalized', threadId, {
    type: 'permission_request', questionId: 'perm-1', toolName: 'Bash', options: [{ id: 'allow', label: 'Allow', kind: 'allow' }],
  } satisfies NormalizedEvent)
  backend.emit('normalized', threadId, {
    type: 'question_request', questionId: 'question-1', questions: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: false }],
  } satisfies NormalizedEvent)
  backend.emit('normalized', threadId, {
    type: 'question_request', questionId: asyncId, responseMode: 'message',
    questions: [{ id: '0', question: 'Which package?', options: [], multiSelect: false }],
  } satisfies NormalizedEvent)
  return { backend, plane, events, lifecycle, sessionId, threadId, asyncId }
}

for (const provider of ['claude-code', 'codex'] as const) {
  describe.serial(`${provider}: a run that ends closes its requests`, () => {
    test('the host tells the provider no and broadcasts each request as expired', async () => {
      const { backend, plane, events, lifecycle, sessionId, threadId, asyncId } = await askingRun(provider)
      try {
        expect(plane.statuses.liveSessionStatus(sessionId)).toBe('awaiting_input')
        backend.stop(threadId)
        await lifecycle.done

        expect(backend.permissions.cleared).toContain(threadId)
        const expired = events.filter((event) => event.type === 'permission_resolved' && event.expired)
        expect(expired).toEqual([
          { type: 'permission_resolved', questionId: 'perm-1', expired: 'run_ended' },
          { type: 'permission_resolved', questionId: 'question-1', expired: 'run_ended' },
        ])
        // The async question is not closed with its run.
        expect(events.some((event) => event.type === 'permission_resolved' && event.questionId === asyncId)).toBe(false)
        expect(plane.inputRequests.respondToPermission(sessionId, 'perm-1', 'allow', undefined, HOST_ACTOR)).toBe(false)
      } finally { plane.shutdown() }
    })

    test('an answer to an expired request is refused with a typed error', async () => {
      const { backend, plane, lifecycle, sessionId, threadId } = await askingRun(provider)
      try {
        backend.stop(threadId)
        await lifecycle.done

        type Handler = (args: unknown[], ctx: { clientId: string; principal: Principal }) => Promise<unknown>
        const handlers = new Map<string, Handler>()
        const server = { register: (name: string, handler: Handler) => handlers.set(name, (args, ctx) => handler(args, withActor(ctx))) } as never
        registerSessionHandlers(server, { sessionRuntime: plane, orchestrator: { mayAnswer: () => true }, agentIdFromContext: () => provider } as never)
        const caller = { clientId: 'ws:owner', principal: OWNER }
        const ctx = { session: { sessionId: sessionId } }

        const permission = handlers.get('respondPermission')!([ctx, sessionId, 'perm-1', 'allow'], caller)
        await expect(permission).rejects.toMatchObject({ code: REQUEST_NOT_ANSWERABLE_CODE })
        const question = handlers.get('respondQuestion')!([ctx, sessionId, 'question-1', { Which: 'A' }], caller)
        await expect(question).rejects.toMatchObject({ code: REQUEST_NOT_ANSWERABLE_CODE })
      } finally { plane.shutdown() }
    })

    test('an async question stays answerable after the provider exits', async () => {
      const { backend, plane, lifecycle, sessionId, threadId, asyncId } = await askingRun(provider)
      try {
        backend.stop(threadId)
        await lifecycle.done
        expect(plane.watchers.watchSession({ sessionId: sessionId}, 'late').pendingQuestions)
          .toContainEqual(expect.objectContaining({ questionId: asyncId }))

        expect(await plane.inputRequests.respondToQuestion(sessionId, asyncId, { '0': 'pnpm' }, HOST_ACTOR)).toBe(true)
        // The answer starts a new turn, as a message.
        expect(backend.starts).toBe(2)
        backend.stop(threadId)
      } finally { plane.shutdown() }
    })
  })
}

describe('a client after a request expires', () => {
  const tab = { hasUnread: false } as Tab
  const permission: PermissionRequest = { questionId: 'perm-1', toolTitle: 'Bash', options: [] }
  const question: QuestionRequest = { questionId: 'question-1', questions: [] }

  function session(permissionQueue: PermissionRequest[], questionQueue: QuestionRequest[]): Session {
    return { status: 'interrupted', permissionQueue, questionQueue, messages: [] } as unknown as Session
  }

  test('the sidebar does not hold a session in awaiting for a request nobody can answer', () => {
    expect(getAttentionState(session([permission], []), tab)).toBe('awaiting')
    expect(getAttentionState(session([], [question]), tab)).toBe('awaiting')
    expect(getAttentionState(session([{ ...permission, expired: 'run_ended' }], [{ ...question, expired: 'closed' }]), tab)).not.toBe('awaiting')
  })

  test('mobile keeps the closed card to say why, and drops it when the next turn starts', () => {
    const model = new TranscriptModel('asking-session')
    model.apply({ type: 'permission_request', questionId: 'perm-1', toolName: 'Bash', options: [] })
    model.apply({ type: 'question_request', questionId: 'async-1', responseMode: 'message', questions: [] })
    model.apply({ type: 'permission_resolved', questionId: 'perm-1', expired: 'run_ended' })
    expect(model.permissions).toEqual([expect.objectContaining({ questionId: 'perm-1', expired: 'run_ended' })])

    // A sync from the host does not drop the message-mode question it does not list.
    model.apply({ type: 'pending_input_sync', pendingInputEvents: [] })
    expect(model.questions.map((entry) => entry.questionId)).toEqual(['async-1'])

    model.apply({ type: 'permission_request', questionId: 'perm-2', toolName: 'Bash', options: [] })
    model.apply({ type: 'permission_resolved', questionId: 'perm-2', expired: 'run_ended' })
    model.setStatus('running')
    expect(model.permissions).toEqual([])
    expect(model.questions.map((entry) => entry.questionId)).toEqual(['async-1'])
  })
})
