import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { HOST_ACTOR } from '@solus/server/admission/actor'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'
import { CodexTurnNormalizer } from '@solus/server/execution/agents/codex/codex-event-normalizer'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SessionRuntimeModule = typeof import('@solus/server/execution/session-runtime')
type MetricsDbModule = typeof import('@solus/server/data/insights/metrics-db')
type DbModule = typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let sessionRuntimeModule: SessionRuntimeModule
let metricsDb: MetricsDbModule
let db: DbModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-control-plane-watch-attach-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionRuntimeModule = await import('@solus/server/execution/session-runtime')
  metricsDb = await import('@solus/server/data/insights/metrics-db')
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
  allowSteering = false
  steeredPrompts: string[] = []

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
  async steerSession(sessionId: string, options: { prompt: string }): Promise<RunHandle | null> {
    if (!this.allowSteering) return null
    this.steeredPrompts.push(options.prompt)
    return this.handles.get(sessionId) ?? null
  }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(): SessionRunInput {
  return {
    provider: 'codex', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'gpt-requested', preferredModel: 'gpt-requested', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

describe.serial('SessionRuntime watchSession runtime attach', () => {
  test('an answer steers an active Codex turn without stopping it', async () => {
    const backend = new Backend()
    backend.allowSteering = true
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['codex', backend]]))
    plane.on('error', () => {})
    try {
      const lifecycle = await plane.runTurn({
        target: { kind: 'new-session' }, sessionId: 'async-steer-session', input: input(), tools: [],
        options: { prompt: 'inspect it', promptSource: 'typed' },
      })
      await lifecycle.agentSessionId
      backend.emit('normalized', 'thread-1', {
        type: 'question_request', questionId: 'codex-async:thread-1:steer-question', responseMode: 'message',
        questions: [{ id: '0', question: 'Which package?', options: [], multiSelect: false }],
      } satisfies NormalizedEvent)
      expect(await plane.respondToQuestion('async-steer-session', 'codex-async:thread-1:steer-question', { '0': 'pnpm' }, HOST_ACTOR)).toBe(true)
      expect(backend.steeredPrompts).toEqual(['Which package?\npnpm'])
      expect(backend.starts).toBe(1)
      expect(plane.liveSessionStatus('thread-1')).toBe('running')
      backend.complete('thread-1')
      await lifecycle.done
    } finally { plane.shutdown() }
  })

  test('native async question survives turn end and its answer resumes Codex', async () => {
    const backend = new Backend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['codex', backend]]))
    plane.on('error', () => {})
    const events: NormalizedEvent[] = []
    plane.on('event', (_sessionId, event: NormalizedEvent) => events.push(event))
    try {
      const lifecycle = await plane.runTurn({
        target: { kind: 'new-session' }, sessionId: 'async-question-session', input: input(), tools: [],
        options: { prompt: 'inspect it', promptSource: 'typed' },
      })
      await lifecycle.agentSessionId
      const [question] = new CodexTurnNormalizer({ planMode: false }).push({
        method: 'item/completed', params: {
          threadId: 'thread-1', item: {
            type: 'agentMessage', id: 'question-1', delivery: 'async', text: 'Which package?',
            questions: [{ title: 'Which package?', options: [] }],
          },
        },
      })
      expect(question?.type).toBe('question_request')
      if (question?.type !== 'question_request') throw new Error('Codex async question was not normalized')
      backend.emit('normalized', 'thread-1', question)
      expect(plane.liveSessionStatus('thread-1')).toBe('running')
      expect(plane.attention.get('thread-1')?.kind).toBe('question')
      expect(plane.watchSession({ sessionId: 'async-question-session', agentSessionId: 'thread-1' }, 'first').pendingQuestions)
        .toEqual([{ questionId: question.questionId, questions: question.questions, responseMode: 'message' }])

      backend.complete('thread-1')
      await lifecycle.done
      expect(plane.attention.get('thread-1')?.kind).toBe('question')
      expect(plane.watchSession({ sessionId: 'async-question-session', agentSessionId: 'thread-1', attachRuntime: true }, 'second'))
        .toMatchObject({ runtime: null, pendingQuestions: [{ questionId: question.questionId }] })
      expect(await plane.respondToQuestion('async-question-session', question.questionId, { '0': 'pnpm' }, HOST_ACTOR)).toBe(true)
      expect(backend.starts).toBe(2)
      expect(plane.watchSession({ sessionId: 'async-question-session', agentSessionId: 'thread-1' }, 'third').pendingQuestions)
        .toBeUndefined()
      expect(events).toContainEqual(expect.objectContaining({
        type: 'question_answered', answer: expect.objectContaining({ questionId: question.questionId }),
      }))
      expect(events).toContainEqual(expect.objectContaining({
        type: 'user_message', via: 'question-answer', text: 'Which package?\npnpm',
      }))
      const history = [{ role: 'user', content: 'Which package?\npnpm', timestamp: 1, questionAnswer: undefined as import('@solus/contracts/types').QuestionAnswer | undefined }]
      const questions = await import('@solus/server/data/sessions/async-questions')
      questions.restoreAsyncQuestionAnswers('thread-1', history)
      expect(history[0].questionAnswer?.answers).toEqual({ '0': 'pnpm' })
      const questionEventsBeforeReplay = events.filter((event) => event.type === 'question_request').length
      backend.emit('normalized', 'thread-1', question)
      expect(events.filter((event) => event.type === 'question_request')).toHaveLength(questionEventsBeforeReplay)
      expect(await plane.respondToQuestion('async-question-session', question.questionId, { '0': 'npm' }, HOST_ACTOR)).toBe(false)
      backend.complete('thread-1')
    } finally { plane.shutdown() }
  })

  test('an async question survives reopening the host database', async () => {
    const questions = await import('@solus/server/data/sessions/async-questions')
    const event: Extract<NormalizedEvent, { type: 'question_request' }> = {
      type: 'question_request', questionId: 'codex-async:stored-thread:stored-question', responseMode: 'message',
      questions: [{ id: '0', question: 'Which branch?', options: [], multiSelect: false }],
    }
    questions.saveAsyncQuestion('stored-session', 'stored-thread', event)
    db.closeDb()
    expect(questions.pendingAsyncQuestions('stored-session')).toEqual([event])
    expect(questions.claimAsyncQuestion('stored-session', event.questionId)).toMatchObject({ agentSessionId: 'stored-thread' })
    questions.settleAsyncQuestion(event.questionId, 'dismissed')
    expect(questions.pendingAsyncQuestions('stored-session')).toEqual([])
  })

  test('a watch that asks to attach answers with the live runtime in the same call', async () => {
    // WHY: opening a session used to be a watch followed by a bind, two round
    // trips for one question. The watch carries the bind's answer so a client
    // joining a live session pays one.
    const backend = new Backend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['codex', backend]]))
    plane.on('error', () => {})
    const replayed: Array<{ sessionId: string; event: NormalizedEvent; only?: string }> = []
    plane.on('event', (sessionId, event: NormalizedEvent, options?: { only?: string }) => {
      replayed.push({ sessionId, event, only: options?.only })
    })

    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-watch-attach', input: input(), tools: [],
      options: { prompt: 'inspect it', promptSource: 'typed' },
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
      permissionMode: 'supervised',
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
  test('reconnect replays delivered blocks without flushing or duplicating a partial paragraph', async () => {
    const backend = new Backend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['codex', backend]]))
    plane.on('error', () => {})
    const events: Array<{ event: NormalizedEvent; only?: string }> = []
    plane.on('event', (_sessionId, event: NormalizedEvent, options?: { only?: string }) => {
      events.push({ event, only: options?.only })
    })
    try {
      const lifecycle = await plane.runTurn({
        target: { kind: 'new-session' }, sessionId: 'reconnect-text', input: input(), tools: [],
        options: { prompt: 'inspect it', promptSource: 'typed' },
      })
      await lifecycle.agentSessionId
      plane.watchSession({ sessionId: 'reconnect-text' }, 'first')
      backend.emit('normalized', 'thread-1', { type: 'text_chunk', text: 'Complete.\n\nPartial' })
      plane.unwatchSession('reconnect-text', 'first')
      events.length = 0
      plane.watchSession({ sessionId: 'reconnect-text', agentSessionId: 'thread-1', attachRuntime: true }, 'second')
      expect(events.filter(item => item.event.type === 'text_chunk')).toEqual([
        { event: { type: 'text_chunk', text: 'Complete.\n\n', streaming: true }, only: 'second' },
      ])
      events.length = 0
      backend.complete('thread-1')
      await lifecycle.done
      expect(events.filter(item => item.event.type === 'text_chunk')).toEqual([
        { event: { type: 'text_chunk', text: 'Partial', streaming: false }, only: undefined },
      ])
    } finally { plane.shutdown() }
  })

})
