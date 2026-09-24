import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentConversationUpdate, AgentMetadata, IpcContext, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'
import { ORCHESTRATION_LIMITS, parseOrchestrationItems, type SessionReport } from '@solus/contracts/session-exchange'

// WHY: the session orchestration layer is the one owner of a message between
// sessions. These flows run the real control plane with a fake provider and
// check the promises it makes: the sender's card shows the message before
// anything can answer it; a request for a person is shown to the sender and
// answered there; results carry references to what the turn produced and never
// its content; a busy sender wakes once for everything that waited; and a
// sender that stopped the target itself is not told about its own stop.

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ControlPlaneModule = typeof import('@solus/server/control-plane')
type RuntimeModule = typeof import('@solus/server/orchestration/control-plane-runtime')
type DbModule = typeof import('@solus/server/db')
type IndexerModule = typeof import('@solus/server/db/session-indexer')
type AnnotationsModule = typeof import('@solus/server/plans/annotations')
type OrchestratorModule = typeof import('@solus/server/orchestration/session-orchestrator')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let controlPlaneModule: ControlPlaneModule
let runtime: RuntimeModule
let db: DbModule
let indexer: IndexerModule
let annotations: AnnotationsModule
let runtimeModule: OrchestratorModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-orchestrator-'))
  process.env.SOLUS_DATA_DIR = dataDir
  controlPlaneModule = await import('@solus/server/control-plane')
  runtime = await import('@solus/server/orchestration/control-plane-runtime')
  db = await import('@solus/server/db')
  indexer = await import('@solus/server/db/session-indexer')
  annotations = await import('@solus/server/plans/annotations')
  runtimeModule = await import('@solus/server/orchestration/session-orchestrator')
})

afterEach(() => {
  db.closeDb()
  for (const file of ['solus.db', 'solus.db-wal', 'solus.db-shm']) rmSync(join(dataDir, file), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

class Permissions implements PermissionResponder {
  readonly permissionAnswers: Array<{ questionId: string; optionId: string }> = []
  readonly questionAnswers: Array<{ questionId: string; answers: Record<string, string> }> = []
  getPendingInfo(): undefined { return undefined }
  respondToPermission(questionId: string, optionId: string): boolean {
    this.permissionAnswers.push({ questionId, optionId })
    return true
  }
  respondToQuestion(questionId: string, answers: Record<string, string>): boolean {
    this.questionAnswers.push({ questionId, answers })
    return true
  }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

class Backend extends EventEmitter implements AgentBackend {
  readonly id = 'codex' as const
  readonly metadata: AgentMetadata = { id: 'codex', label: 'Codex', models: [], defaultModel: 'gpt-test' }
  readonly permissions = new Permissions()
  readonly handles = new Map<string, RunHandle>()
  readonly requests: AgentRunRequest[] = []
  private startWaiters: Array<{ count: number; resolve: () => void }> = []
  starts = 0

  /** Resolves once the backend has been asked for `count` runs and the last has its thread. */
  started(count: number): Promise<void> {
    if (this.requests.length >= count && this.starts === this.requests.length && this.initialized >= count) return Promise.resolve()
    return new Promise((resolve) => this.startWaiters.push({ count, resolve }))
  }

  private initialized = 0
  private runWaiters: Array<{ matches: (request: AgentRunRequest) => boolean; resolve: (request: AgentRunRequest) => void }> = []

  /** Resolves with the first run, from now or already made, that `matches` accepts. */
  run(matches: (request: AgentRunRequest) => boolean): Promise<AgentRunRequest> {
    const made = this.requests.find(matches)
    if (made) return Promise.resolve(made)
    return new Promise((resolve) => this.runWaiters.push({ matches, resolve }))
  }

  startRun(request: AgentRunRequest): RunHandle {
    this.requests.push(request)
    for (const waiter of this.runWaiters.filter((candidate) => candidate.matches(request))) waiter.resolve(request)
    this.runWaiters = this.runWaiters.filter((candidate) => !candidate.matches(request))
    const resumedThreadId = request.conversation?.kind === 'resume' ? request.conversation.threadId : null
    const threadId = resumedThreadId ?? `thread-${this.starts + 1}`
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: resumedThreadId ?? null,
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
    this.handles.set(threadId, handle)
    queueMicrotask(() => {
      handle.agentSessionId = threadId
      this.emit('normalized', threadId, { type: 'session_init', sessionId: threadId, model: 'gpt-test', skills: [] } satisfies NormalizedEvent)
      this.initialized++
      for (const waiter of this.startWaiters.filter((candidate) => this.initialized >= candidate.count)) waiter.resolve()
    })
    return handle
  }

  complete(threadId: string, result = 'done'): void {
    const handle = this.handles.get(threadId)!
    handle.resultText = result
    this.emit('normalized', threadId, {
      type: 'task_complete', result, costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: threadId,
    } satisfies NormalizedEvent)
    handle._resolveRun()
    this.handles.delete(threadId)
    this.emit('exit', threadId, 0, null)
  }

  send(threadId: string, event: NormalizedEvent): void { this.emit('normalized', threadId, event) }

  /** The provider refuses the turn on a spent account and ends it — the shape
   *  that parks the run until `resetsAt` (milliseconds). */
  rateLimit(threadId: string, resetsAt: number): void {
    this.emit('normalized', threadId, {
      type: 'usage_limits', windows: [{ windowDurationMins: 300, usedPercent: 100, resetsAt }],
    } satisfies NormalizedEvent)
    this.emit('normalized', threadId, {
      type: 'rate_limit', status: 'limited', resetsAt: null, rateLimitType: 'Codex 5h', isUsingOverage: false, windowDurationMins: 300,
    } satisfies NormalizedEvent)
    const handle = this.handles.get(threadId)!
    handle._resolveRun()
    this.handles.delete(threadId)
    this.emit('exit', threadId, 0, null)
  }
  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(threadId: string): boolean {
    const handle = this.handles.get(threadId)
    if (!handle) return false
    handle.abortController.abort()
    queueMicrotask(() => {
      handle._resolveRun()
      this.handles.delete(threadId)
      this.emit('exit', threadId, null, 'SIGINT')
    })
    return true
  }
  isSessionRunning(sessionId: string): boolean { return this.handles.has(sessionId) }
  async steerSession(): Promise<null> { return null }
  loadSession(): Promise<never[]> { return Promise.resolve([]) }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 } }
  listSessions(): Promise<never[]> { return Promise.resolve([]) }
  listPlans(): Promise<never[]> { return Promise.resolve([]) }
  loadPlanContent(): Promise<null> { return Promise.resolve(null) }
  listPluginCommands(): Promise<{ global: never[]; project: never[] }> { return Promise.resolve({ global: [], project: [] }) }
  refreshPluginCommands(): Promise<void> { return Promise.resolve() }
  shutdown(): void {}
}

function input(): SessionRunInput {
  return {
    provider: 'codex', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'gpt-test', preferredModel: 'gpt-test', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'auto', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

/** Event-loop turns, not wall-clock time: resolves once `ready` holds. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !ready(); turn++) await new Promise((resolve) => setImmediate(resolve))
  expect(ready()).toBe(true)
}

function isReportFor(senderThreadId: string): (request: AgentRunRequest) => boolean {
  return (request) => request.conversation?.kind === 'resume' && request.conversation.threadId === senderThreadId
    && request.prompt.includes('[session report v2')
}

/** The reports in one prompt the sender's model received. */
function reportsIn(prompt: string): SessionReport[] {
  return (parseOrchestrationItems(prompt) ?? []).flatMap((item) => item.type === 'report' ? [item.report] : [])
}

/** The reports the sender's model received, one per run it was woken for. */
function reportRuns(backend: Backend, senderThreadId: string): string[] {
  return backend.requests.filter(isReportFor(senderThreadId)).map((request) => request.prompt)
}

/** Sessions with their turns open: targets thread-1 (and thread-3), sender thread-2. */
async function sessions(options: { secondTarget?: boolean } = {}) {
  const backend = new Backend()
  const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
  plane.on('error', () => {})
  const orchestrator = runtime.orchestrateSessions(plane)
  const updates: AgentConversationUpdate[] = []
  /** The sender's queued prompts, by queue id, as its clients see them. */
  const senderQueue = new Set<string>()
  plane.on('event', (sessionId: string, event: NormalizedEvent) => {
    if (sessionId !== 'solus-sender') return
    if (event.type === 'agent_conversation_update') updates.push(event.update)
    if (event.type === 'prompt_queued') senderQueue.add(event.queueId)
    if (event.type === 'prompt_dequeued') senderQueue.delete(event.queueId)
  })
  const open = async (sessionId: string, prompt: string) => {
    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId, input: input(), tools: [],
      options: { prompt, promptSource: 'agent', skipTaskCreation: true },
    })
    await lifecycle.agentSessionId
  }
  await open('solus-target', 'start')
  await open('solus-sender', 'coordinate')
  if (options.secondTarget) await open('solus-second', 'start too')
  return { backend, plane, orchestrator, updates, senderQueue }
}

describe('session orchestration', () => {
  test('a message waits behind a busy target, runs, and its reply wakes the sender once', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'follow up', delivery: 'queue', notify: true })
      expect(sent.disposition).toBe('queued')
      expect(updates.map((update) => update.phase)).toEqual(['dispatched', 'accepted'])
      expect(updates[0]).toMatchObject({ messageId: sent.exchangeId, agentSessionId: 'thread-1', prompt: 'follow up' })
      expect(updates[1]).toMatchObject({ state: 'queued' })
      expect(orchestrator.exchangesSentBy('solus-sender')).toEqual([
        { messageId: sent.exchangeId, targetAgentSessionId: 'thread-1', state: 'queued' },
      ])
      // The sender stays running while it waits for a reply its model will read.
      expect(orchestrator.isAwaitingReplies('solus-sender')).toBe(true)

      backend.complete('thread-1', 'first')
      await backend.started(3)
      await until(() => updates.some((update) => update.phase === 'accepted' && update.state === 'running'))
      expect(orchestrator.exchangesSentBy('thread-2')).toEqual([
        { messageId: sent.exchangeId, targetAgentSessionId: 'thread-1', state: 'running' },
      ])

      backend.complete('thread-1', 'second')
      await until(() => updates.some((update) => update.phase === 'settled'))
      expect(updates.at(-1)).toMatchObject({ phase: 'settled', messageId: sent.exchangeId, status: 'completed', replyText: 'second' })
      expect(orchestrator.isAwaitingReplies('solus-sender')).toBe(false)

      // The sender's own turn ends; the one report that waited for it runs.
      backend.complete('thread-2', 'coordinated')
      await backend.run(isReportFor('thread-2'))
      expect(reportsIn(reportRuns(backend, 'thread-2')[0]!)).toEqual([
        { messageId: sent.exchangeId, agentSessionId: 'thread-1', provider: 'codex', status: 'completed', durationMs: expect.any(Number), outputs: [], reply: 'second' },
      ])
    } finally {
      plane.shutdown()
    }
  })

  test('a message to a session that does not exist is refused before the card shows it', async () => {
    const { plane, orchestrator, updates } = await sessions()
    try {
      await expect(orchestrator.send('thread-2', 'thread-missing', { prompt: 'hello', delivery: 'queue', notify: true })).rejects.toThrow('not found')
      expect(updates).toEqual([])
      expect(orchestrator.exchangesSentBy('solus-sender')).toEqual([])
    } finally {
      plane.shutdown()
    }
  })

  test("a target's question is shown to the sender and answered there, without waking the sender's model", async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'which branch?', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      await backend.started(3)
      const questions = [{ id: 'branch', question: 'Which branch?', options: [{ label: 'main' }], multiSelect: false }]
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions })
      await until(() => updates.some((update) => update.phase === 'awaiting_input'))
      expect(updates.find((update) => update.phase === 'awaiting_input')).toEqual({
        phase: 'awaiting_input', agentSessionId: 'thread-1', messageId: sent.exchangeId,
        request: { kind: 'question', question: { questionId: 'q1', questions } },
      })
      // A reloaded card learns the request from the host.
      expect(orchestrator.exchangesSentBy('solus-sender')[0]).toMatchObject({ state: 'awaiting_input', request: { kind: 'question' } })

      // Only the sender waiting on that turn, and the target itself, may answer it.
      expect(orchestrator.mayAnswer('solus-sender', 'thread-1')).toBe(true)
      expect(orchestrator.mayAnswer('solus-target', 'thread-1')).toBe(true)
      expect(orchestrator.mayAnswer('solus-stranger', 'thread-1')).toBe(false)

      // The person's answer, from the sender's card or the target's own tab.
      expect(plane.respondToQuestion('thread-1', 'q1', { branch: 'main' })).toBe(true)
      expect(updates.find((update) => update.phase === 'answered')).toEqual({
        phase: 'answered', agentSessionId: 'thread-1', messageId: sent.exchangeId, answerText: 'Which branch? → main',
      })

      backend.complete('thread-1', 'shipped on main')
      await until(() => updates.some((update) => update.phase === 'settled'))
      backend.complete('thread-2')
      await backend.run(isReportFor('thread-2'))
      // The report says what was asked and answered.
      expect(reportsIn(reportRuns(backend, 'thread-2')[0]!)[0]).toMatchObject({
        outputs: [{ kind: 'question', question: 'Which branch?', answer: 'main' }],
        reply: 'shipped on main',
      })
    } finally {
      plane.shutdown()
    }
  })

  test('a result names the works and changed files the turn produced, never their content', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'write it up', delivery: 'queue', notify: true })
      backend.complete('thread-1')
      await backend.started(3)
      backend.send('thread-1', { type: 'work_created', workId: 'work-1', title: 'Design', docType: 'doc', content: '' })
      backend.send('thread-1', { type: 'session_changed_files_updated', paths: [] })
      backend.send('thread-1', { type: 'session_changed_files_updated', paths: ['src/a.ts'] })
      backend.complete('thread-1', 'written')
      await until(() => updates.some((update) => update.phase === 'settled'))
      // The card gets the paths to list; the model gets a count.
      expect(updates.find((update) => update.phase === 'settled')).toMatchObject({
        messageId: sent.exchangeId,
        outputs: [
          { kind: 'work', workId: 'work-1', title: 'Design', workType: 'doc' },
          { kind: 'changed_files', sessionId: 'thread-1', count: 1, paths: ['src/a.ts'] },
        ],
      })
      backend.complete('thread-2')
      await backend.run(isReportFor('thread-2'))
      const prompt = reportRuns(backend, 'thread-2')[0]!
      expect(prompt).not.toContain('src/a.ts')
      const outputs = reportsIn(prompt)[0]?.outputs
      expect(outputs).toMatchObject([
        { kind: 'work', workId: 'work-1', title: 'Design', workType: 'doc' },
        { kind: 'changed_files', sessionId: 'thread-1', count: 1 },
      ])
      expect(outputs?.[1]).not.toHaveProperty('paths')
    } finally {
      plane.shutdown()
    }
  })

  test('a question the turn ended without an answer to comes back unanswered', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'which branch?', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      await backend.started(3)
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions: [{ id: 'b', question: 'Which branch?', options: [], multiSelect: false }] })
      await until(() => updates.some((update) => update.phase === 'awaiting_input'))
      backend.complete('thread-1', 'gave up waiting')
      await until(() => updates.some((update) => update.phase === 'settled'))
      expect(updates.find((update) => update.phase === 'settled')).toMatchObject({ outputs: [{ kind: 'question', question: 'Which branch?' }] })
      const settled = updates.find((update) => update.phase === 'settled')
      expect(settled?.phase === 'settled' && settled.outputs?.[0]).not.toHaveProperty('answer')
    } finally {
      plane.shutdown()
    }
  })

  test("a session the target starts during the turn is one of the turn's outputs", async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'split the work', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      await backend.started(3)
      const grandchild = await orchestrator.spawn('thread-1', {
        prompt: 'Write the tests', provider: 'codex', modelId: 'gpt-test', reasoningEffort: 'medium', contextWindow: null, cwd: process.cwd(),
      }, true)
      backend.complete('thread-1', 'split')
      await until(() => updates.some((update) => update.phase === 'settled'))
      expect(updates.find((update) => update.phase === 'settled')).toMatchObject({
        outputs: [{ kind: 'session', sessionId: grandchild.agentSessionId, title: 'Write the tests' }],
      })
    } finally {
      plane.shutdown()
    }
  })

  test('a turn that changed no files reports no changed-files output', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'just read', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      await backend.started(3)
      backend.send('thread-1', { type: 'session_changed_files_updated', paths: [] })
      backend.complete('thread-1', 'read it')
      await until(() => updates.some((update) => update.phase === 'settled'))
      const settled = updates.find((update) => update.phase === 'settled')
      expect(settled?.phase === 'settled' && settled.outputs).toBeFalsy()
    } finally {
      plane.shutdown()
    }
  })

  test('a long reply reaches the sender cut, pointing at the rest', async () => {
    const { backend, plane, orchestrator } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'dump it', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      await backend.started(3)
      backend.complete('thread-1', 'y'.repeat(ORCHESTRATION_LIMITS.reply * 3))
      backend.complete('thread-2')
      await backend.run(isReportFor('thread-2'))
      const prompt = reportRuns(backend, 'thread-2')[0]!
      expect(prompt.length).toBeLessThan(ORCHESTRATION_LIMITS.reply + 1_000)
      expect(reportsIn(prompt)[0]!.reply).toContain('read_session session_id=thread-1')
    } finally {
      plane.shutdown()
    }
  })

  test('results that wait behind one busy sender wake it once, together', async () => {
    const { backend, plane, orchestrator, updates } = await sessions({ secondTarget: true })
    try {
      const toFirst = await orchestrator.send('thread-2', 'thread-1', { prompt: 'part one', delivery: 'queue', notify: true })
      const toSecond = await orchestrator.send('thread-2', 'thread-3', { prompt: 'part two', delivery: 'queue', notify: true })
      backend.complete('thread-1')
      backend.complete('thread-3')
      await backend.started(5)
      backend.complete('thread-1', 'one done')
      backend.complete('thread-3', 'two done')
      await until(() => updates.filter((update) => update.phase === 'settled').length === 2)
      // Both reports queued behind the sender's open turn, merged into one prompt.
      await until(() => orchestrator.exchangesSentBy('solus-sender').filter((message) => message.state === 'reply_queued').length === 2)

      backend.complete('thread-2')
      await backend.run(isReportFor('thread-2'))
      expect(reportsIn(reportRuns(backend, 'thread-2')[0]!).map((report) => [report.messageId, report.reply])).toEqual([
        [toFirst.exchangeId, 'one done'],
        [toSecond.exchangeId, 'two done'],
      ])
    } finally {
      plane.shutdown()
    }
  })

  test('a sender that stops its target is not told about its own stop', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'long job', delivery: 'queue', notify: true })
      backend.complete('thread-1')
      await backend.started(3)
      expect(orchestrator.stop('thread-2', 'thread-1')).toBe(true)
      await until(() => updates.some((update) => update.phase === 'settled'))
      expect(updates.find((update) => update.phase === 'stopped')).toEqual({ phase: 'stopped', agentSessionId: 'thread-1' })
      expect(updates.find((update) => update.phase === 'settled')).toMatchObject({ messageId: sent.exchangeId, status: 'interrupted' })
      backend.complete('thread-2')
      await until(() => !plane.isSessionBusy('solus-sender'))
      expect(reportRuns(backend, 'thread-2')).toEqual([])
    } finally {
      plane.shutdown()
    }
  })

  test("a person's plan approval answers the plan's own permission, in place", async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'plan it', delivery: 'queue', notify: true })
      backend.complete('thread-1')
      await backend.started(3)
      backend.send('thread-1', planEvent())
      await until(() => updates.some((update) => update.phase === 'awaiting_input'))
      expect(updates.find((update) => update.phase === 'awaiting_input')).toMatchObject({
        messageId: sent.exchangeId,
        request: { kind: 'plan', plan: { questionId: 'plan-q', planToolUseId: 'tool-plan', title: 'Ship the parser', blocking: true } },
      })

      expect(await orchestrator.decidePlan('solus-sender', 'thread-1', 'approve')).toBe(true)
      // The event's own allow id — Claude says `allow`, Codex `accept`.
      expect(backend.permissions.permissionAnswers).toEqual([{ questionId: 'plan-q', optionId: 'allow-plan' }])
      expect(updates.find((update) => update.phase === 'answered')).toMatchObject({ messageId: sent.exchangeId, answerText: 'Approved the plan' })
      const stored = await annotations.loadAnnotations('local', 'thread-1', 'tool-plan')
      expect(stored?.status).toBe('accepted')
    } finally {
      plane.shutdown()
    }
  })

  test('asking for changes keeps the same message: the revised plan is its reply', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'plan it', delivery: 'queue', notify: true })
      backend.complete('thread-1')
      await backend.started(3)
      backend.send('thread-1', planEvent())
      await until(() => updates.some((update) => update.phase === 'awaiting_input'))

      // Without a comment there is nothing to revise against.
      expect(await orchestrator.decidePlan('solus-sender', 'thread-1', 'request_changes', '  ')).toBe(false)
      expect(await orchestrator.decidePlan('solus-sender', 'thread-1', 'request_changes', 'Cover the error path')).toBe(true)
      expect(backend.permissions.permissionAnswers).toEqual([{ questionId: 'plan-q', optionId: 'deny-plan' }])
      // The sender's card shows what the person asked for.
      expect(updates.find((update) => update.phase === 'answered')).toEqual({
        phase: 'answered', agentSessionId: 'thread-1', messageId: sent.exchangeId, answerText: 'Asked for changes to the plan: Cover the error path',
      })
      // The revision waits behind the turn that held the plan, in plan mode.
      backend.complete('thread-1', 'held plan ended')
      await backend.started(4)
      const revision = backend.requests[3]!
      expect(revision.prompt).toBe('Please revise the plan with these comments:\n\nCover the error path')
      expect(revision.permissionMode).toBe('plan')
      // The run that held the plan ended without ending the message.
      expect(updates.filter((update) => update.phase === 'settled')).toEqual([])

      backend.complete('thread-1', 'revised plan')
      await until(() => updates.some((update) => update.phase === 'settled'))
      expect(updates.filter((update) => update.phase === 'settled')).toEqual([
        expect.objectContaining({ messageId: sent.exchangeId, status: 'completed', replyText: 'revised plan' }),
      ])
      const stored = await annotations.loadAnnotations('local', 'thread-1', 'tool-plan')
      expect(stored?.status).toBe('rejected')
      expect(stored?.comments.at(-1)).toMatchObject({ comment: 'Cover the error path', author: 'you' })
    } finally {
      plane.shutdown()
    }
  })

  test('a plan whose turn already ended is approved by a follow-up message', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'plan it', delivery: 'queue', notify: true })
      backend.complete('thread-1')
      await backend.started(3)
      // Codex reports its plan with no permission to hold the turn open.
      backend.send('thread-1', { ...planEvent(), options: [] })
      backend.complete('thread-1', 'here is the plan')
      await until(() => updates.some((update) => update.phase === 'settled'))

      expect(await orchestrator.decidePlan('solus-sender', 'thread-1', 'approve')).toBe(true)
      expect(backend.permissions.permissionAnswers).toEqual([])
      await backend.started(4)
      expect(backend.requests[3]!.prompt).toStartWith('Implement this plan:\n\n# Ship the parser')
      expect(updates.filter((update) => update.phase === 'dispatched')).toHaveLength(2)
    } finally {
      plane.shutdown()
    }
  })

  test('a session that sent the target nothing cannot decide its plan', async () => {
    const { backend, plane, orchestrator } = await sessions()
    try {
      backend.send('thread-1', planEvent())
      expect(await orchestrator.decidePlan('solus-sender', 'thread-1', 'approve')).toBe(false)
      expect(backend.permissions.permissionAnswers).toEqual([])
    } finally {
      plane.shutdown()
    }
  })

  test('a restart tells a delegating parent its child was interrupted, and only a delegating one', async () => {
    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    plane.on('error', () => {})
    const orchestrator = runtime.orchestrateSessions(plane)
    try {
      const cwd = process.cwd()
      indexer.persistIndexedSessionStart('thread-parent', 'codex', cwd, cwd, 'gpt-test', 'medium')
      indexer.persistIndexedSessionStart('thread-child', 'codex', cwd, cwd, 'gpt-test', 'medium', null, null, {
        parentSessionId: 'thread-parent', messageId: 'm0', intent: 'delegate', createdAt: Date.now(),
      })
      indexer.persistIndexedSessionStart('thread-launched', 'codex', cwd, cwd, 'gpt-test', 'medium', null, null, {
        parentSessionId: 'thread-parent', messageId: 'm9', intent: 'fire_and_forget', createdAt: Date.now(),
      })

      orchestrator.reportChildrenInterruptedByRestart(['thread-launched', 'thread-child'])
      await backend.started(1)
      expect(backend.requests).toHaveLength(1)
      expect(backend.requests[0]!.conversation).toEqual({ kind: 'resume', threadId: 'thread-parent' })
      expect(reportsIn(backend.requests[0]!.prompt)).toEqual([
        expect.objectContaining({ messageId: 'm0', agentSessionId: 'thread-child', status: 'interrupted' }),
      ])
    } finally {
      plane.shutdown()
    }
  })
})

/** Resolves once the orchestrator has woken the sender's model. */
async function orchestratorRun(backend: Backend, senderThreadId: string): Promise<void> {
  await backend.run((request) => request.conversation?.kind === 'resume' && request.conversation.threadId === senderThreadId
    && parseOrchestrationItems(request.prompt) !== null)
}

/** Every prompt the sender's model received that the orchestrator wrote. */
function orchestratorRuns(backend: Backend, senderThreadId: string): string[] {
  return backend.requests
    .filter((request) => request.conversation?.kind === 'resume' && request.conversation.threadId === senderThreadId)
    .map((request) => request.prompt)
    .filter((prompt) => parseOrchestrationItems(prompt) !== null)
}

// WHY: the user spends most of the time in the parent, so the parent must hear
// at once when a child is blocked on a person — but never act on a question
// that is already answered, never be told twice about one request, and never
// be told about a child it launched without asking to hear back.
describe('notices to the parent', () => {
  const questions = [{ id: 'db', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], multiSelect: false }]

  test('an idle parent is woken at once by a question, with the question and no more', async () => {
    const { backend, plane, orchestrator } = await sessions()
    try {
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'pick a database', delivery: 'queue', notify: true })
      backend.complete('thread-2', 'waiting on the child')
      backend.complete('thread-1', 'first')
      await backend.started(3)
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions })
      await orchestratorRun(backend, 'thread-2')
      const [item] = parseOrchestrationItems(orchestratorRuns(backend, 'thread-2')[0]!)!
      expect(item).toEqual({ type: 'notice', notice: {
        messageId: sent.exchangeId, agentSessionId: 'thread-1', provider: 'codex',
        kind: 'question', questionId: 'q1', questions: [{ question: 'Which database?', options: ['SQLite', 'Postgres'] }],
      } })
    } finally {
      plane.shutdown()
    }
  })

  test('a question answered before a busy parent reads it is taken back; the report says how it ended', async () => {
    const { backend, plane, orchestrator, senderQueue } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'pick a database', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      await backend.started(3)
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions })
      await until(() => orchestrator.exchangesSentBy('solus-sender').some((message) => message.state === 'awaiting_input'))
      await until(() => senderQueue.size === 1)
      expect(plane.respondToQuestion('thread-1', 'q1', { db: 'SQLite' })).toBe(true)
      await until(() => senderQueue.size === 0)

      backend.complete('thread-1', 'using SQLite')
      backend.complete('thread-2', 'coordinated')
      await backend.run(isReportFor('thread-2'))
      const prompts = orchestratorRuns(backend, 'thread-2')
      expect(prompts).toHaveLength(1)
      expect(parseOrchestrationItems(prompts[0]!)).toEqual([{ type: 'report', report: expect.objectContaining({
        outputs: [{ kind: 'question', question: 'Which database?', answer: 'SQLite' }],
        reply: 'using SQLite',
      }) }])
    } finally {
      plane.shutdown()
    }
  })

  test('a notice and a report that wait for one busy parent reach it together, in order', async () => {
    const { backend, plane, orchestrator, senderQueue } = await sessions({ secondTarget: true })
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'pick a database', delivery: 'queue', notify: true })
      await orchestrator.send('thread-2', 'thread-3', { prompt: 'write docs', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      backend.complete('thread-3', 'first')
      await backend.started(5)
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions })
      await until(() => senderQueue.size === 1)
      backend.complete('thread-3', 'docs written')
      await until(() => orchestrator.exchangesSentBy('solus-sender').some((message) => message.state === 'reply_queued'))
      // Still one queued prompt: the report merged into the notice's.
      expect(senderQueue.size).toBe(1)

      backend.complete('thread-2', 'coordinated')
      await orchestratorRun(backend, 'thread-2')
      expect(parseOrchestrationItems(orchestratorRuns(backend, 'thread-2')[0]!)?.map((item) => item.type)).toEqual(['notice', 'report'])
    } finally {
      plane.shutdown()
    }
  })

  test('a parent that launched a child without asking to hear back is never told', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'go', delivery: 'queue', notify: false })
      backend.complete('thread-2', 'launched')
      backend.complete('thread-1', 'first')
      await backend.started(3)
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions })
      // The card still shows it for a person.
      await until(() => updates.some((update) => update.phase === 'awaiting_input'))
      expect(plane.respondToQuestion('thread-1', 'q1', { db: 'SQLite' })).toBe(true)
      backend.complete('thread-1', 'done')
      await until(() => updates.some((update) => update.phase === 'settled'))
      expect(orchestratorRuns(backend, 'thread-2')).toEqual([])
    } finally {
      plane.shutdown()
    }
  })

  test('a plan notice names the plan and never carries its text', async () => {
    const { backend, plane, orchestrator } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'plan it', delivery: 'queue', notify: true })
      backend.complete('thread-2', 'waiting')
      backend.complete('thread-1', 'first')
      await backend.started(3)
      backend.send('thread-1', planEvent())
      await orchestratorRun(backend, 'thread-2')
      const prompt = orchestratorRuns(backend, 'thread-2')[0]!
      expect(prompt).not.toContain('1. Parse')
      expect(parseOrchestrationItems(prompt)).toEqual([{ type: 'notice', notice: expect.objectContaining({
        kind: 'plan', title: 'Ship the parser', planToolUseId: 'tool-plan', questionId: 'plan-q',
      }) }])
    } finally {
      plane.shutdown()
    }
  })
})

// WHY: most work is async, but a parent sometimes cannot continue without the
// answer. A waiting call gets the outcome as its own result — the report, or the
// notice that the child is blocked — and then nothing else is queued for it, so
// the parent never reads one outcome twice. When the time runs out the call
// returns and the child keeps going: a wait never stops the work.
describe('waiting for an outcome inside the call', () => {
  const questions = [{ id: 'db', question: 'Which database?', options: [], multiSelect: false }]

  test('a turn that ends in time is the call\'s result, and no report is queued', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      backend.complete('thread-1', 'first')
      await until(() => !backend.handles.has('thread-1'))
      const sending = orchestrator.send('thread-2', 'thread-1', { prompt: 'quick check', delivery: 'queue', notify: true, waitMs: 60_000 })
      await backend.started(3)
      backend.complete('thread-1', 'checked')
      const sent = await sending
      expect(sent.waited).toEqual({ type: 'report', report: expect.objectContaining({ messageId: sent.exchangeId, status: 'completed', reply: 'checked' }) })
      // The card still settles.
      expect(updates.find((update) => update.phase === 'settled')).toMatchObject({ messageId: sent.exchangeId, replyText: 'checked' })
      backend.complete('thread-2', 'done')
      await until(() => !plane.isSessionBusy('solus-sender'))
      expect(orchestratorRuns(backend, 'thread-2')).toEqual([])
    } finally {
      plane.shutdown()
    }
  })

  test('a question ends the wait at once with its notice; the report still comes later', async () => {
    const { backend, plane, orchestrator } = await sessions()
    try {
      backend.complete('thread-1', 'first')
      await until(() => !backend.handles.has('thread-1'))
      const sending = orchestrator.send('thread-2', 'thread-1', { prompt: 'pick one', delivery: 'queue', notify: true, waitMs: 60_000 })
      await backend.started(3)
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions })
      const sent = await sending
      expect(sent.waited).toEqual({ type: 'notice', notice: expect.objectContaining({ kind: 'question', questionId: 'q1' }) })

      expect(plane.respondToQuestion('thread-1', 'q1', { db: 'SQLite' })).toBe(true)
      backend.complete('thread-1', 'using SQLite')
      backend.complete('thread-2', 'waiting')
      await orchestratorRun(backend, 'thread-2')
      // Only the report: the notice already reached the caller.
      expect(parseOrchestrationItems(orchestratorRuns(backend, 'thread-2')[0]!)?.map((item) => item.type)).toEqual(['report'])
    } finally {
      plane.shutdown()
    }
  })

  test('when the time runs out the call returns, the child keeps running, and the report comes later', async () => {
    const { backend, plane, orchestrator } = await sessions()
    try {
      backend.complete('thread-1', 'first')
      await until(() => !backend.handles.has('thread-1'))
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'long job', delivery: 'queue', notify: true, waitMs: 1 })
      expect(sent.waited).toBeNull()
      await backend.started(3)
      expect(backend.handles.has('thread-1')).toBe(true)
      backend.complete('thread-1', 'long job done')
      backend.complete('thread-2', 'moved on')
      await orchestratorRun(backend, 'thread-2')
      expect(reportsIn(orchestratorRuns(backend, 'thread-2')[0]!).map((report) => report.reply)).toEqual(['long job done'])
    } finally {
      plane.shutdown()
    }
  })

  test('a turn that answers a message is asked to end with a summary; an ordinary turn is not', async () => {
    const { backend, plane, orchestrator } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'do the part', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      const answering = await backend.run((request) => request.prompt === 'do the part')
      expect(answering.systemPrompt).toContain(runtimeModule.ANSWERING_ANOTHER_SESSION)
      expect(backend.requests[0]!.systemPrompt ?? '').not.toContain(runtimeModule.ANSWERING_ANOTHER_SESSION)
    } finally {
      plane.shutdown()
    }
  })
})

// WHY: a report's reply is what the parent acts on. It must be this turn's own
// reply, never an earlier turn's, and a turn that failed without a word must
// say why — found in a live test, where a provider refused the model and the
// parent read only "no final assistant reply".
describe('how a turn ended', () => {
  test("reads only the last turn's reply, and the error a failed turn stopped on", () => {
    const earlier = [
      { role: 'user', content: 'first job', timestamp: 1 },
      { role: 'assistant', content: 'first job done', timestamp: 2 },
    ]
    expect(runtimeModule.turnEnding(earlier)).toEqual({ reply: 'first job done' })
    const failed = [
      ...earlier,
      { role: 'user', content: 'second job', timestamp: 3 },
      { role: 'system', content: 'Error: {"message":"The model is not supported."}', timestamp: 4 },
    ]
    expect(runtimeModule.turnEnding(failed)).toEqual({ error: 'Error: {"message":"The model is not supported."}' })
    // A subagent's words are not the turn's reply.
    expect(runtimeModule.turnEnding([{ role: 'user', content: 'go', timestamp: 1 }, { role: 'assistant', content: 'inner', parentToolUseId: 't1', timestamp: 2 }])).toEqual({})
  })
})

// WHY: a child parked on its provider's rate limit can wait hours. The card and
// the parent must say so at once instead of showing "working"; the parked turn
// must resume on its own with its message still open; and the parent — which
// can itself be limited — must lose nothing that was sent to it meanwhile.
describe('rate limits', () => {
  const inAnHour = () => Math.ceil((Date.now() + 3_600_000) / 1000) * 1000

  test('a child parked on a limit shows it, tells the parent once, and resumes on its own', async () => {
    const { backend, plane, orchestrator, updates, senderQueue } = await sessions()
    try {
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'long job', delivery: 'queue', notify: true })
      const parkedForReset: string[] = []
      plane.on('event', (sessionId: string, event: NormalizedEvent) => {
        if (sessionId === 'solus-target' && event.type === 'prompt_queued' && event.reason === 'rate_limit') parkedForReset.push(event.queueId)
      })
      backend.complete('thread-1', 'first')
      await backend.started(3)
      const resetsAt = inAnHour()
      backend.rateLimit('thread-1', resetsAt)
      await until(() => updates.some((update) => update.phase === 'rate_limited'))
      const limited = updates.find((update) => update.phase === 'rate_limited')
      expect(limited).toMatchObject({ messageId: sent.exchangeId, agentSessionId: 'thread-1', limitType: 'Codex 5h' })
      // The reset the provider stated, give or take Codex's send buffer.
      expect(limited?.phase === 'rate_limited' && limited.resetsAt! >= resetsAt).toBe(true)
      expect(orchestrator.exchangesSentBy('solus-sender')).toEqual([expect.objectContaining({ messageId: sent.exchangeId, state: 'rate_limited' })])
      // Parked, not ended: nothing settled. The message waits in the child's
      // queue for the reset — not on a decision nobody at the child's tab makes.
      expect(updates.some((update) => update.phase === 'settled')).toBe(false)
      expect(parkedForReset).toHaveLength(1)
      await until(() => senderQueue.size === 1)

      // The limit ends: the same message runs again, and the unread notice goes.
      expect(plane.resolveRateLimit({ session: { sessionId: 'solus-target' } } as IpcContext, 'send_now')).toBe(true)
      await backend.started(4)
      const parkedAt = updates.findIndex((update) => update.phase === 'rate_limited')
      await until(() => updates.findLastIndex((update) => update.phase === 'accepted' && update.state === 'running') > parkedAt)
      await until(() => senderQueue.size === 0)
      backend.complete('thread-1', 'finished after the reset')
      await until(() => updates.some((update) => update.phase === 'settled'))
      expect(updates.find((update) => update.phase === 'settled')).toMatchObject({ messageId: sent.exchangeId, status: 'completed', replyText: 'finished after the reset' })

      backend.complete('thread-2')
      await orchestratorRun(backend, 'thread-2')
      expect(parseOrchestrationItems(orchestratorRuns(backend, 'thread-2')[0]!)?.map((item) => item.type)).toEqual(['report'])
    } finally {
      plane.shutdown()
    }
  })

  test('an idle parent reads the limit notice, with the reset time', async () => {
    const { backend, plane, orchestrator } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'long job', delivery: 'queue', notify: true })
      backend.complete('thread-2', 'waiting')
      backend.complete('thread-1', 'first')
      await backend.started(3)
      backend.rateLimit('thread-1', inAnHour())
      await orchestratorRun(backend, 'thread-2')
      expect(parseOrchestrationItems(orchestratorRuns(backend, 'thread-2')[0]!)).toEqual([{ type: 'notice', notice: expect.objectContaining({
        kind: 'rate_limited', agentSessionId: 'thread-1', limitType: 'Codex 5h', resetsAt: expect.any(Number),
      }) }])
    } finally {
      plane.shutdown()
    }
  })

  test('a person stopping the parked child from its own tab settles the message interrupted', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      const sent = await orchestrator.send('thread-2', 'thread-1', { prompt: 'long job', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      await backend.started(3)
      backend.rateLimit('thread-1', inAnHour())
      await until(() => updates.some((update) => update.phase === 'rate_limited'))
      expect(plane.resolveRateLimit({ session: { sessionId: 'solus-target' } } as IpcContext, 'stop')).toBe(true)
      await until(() => updates.some((update) => update.phase === 'settled'))
      expect(updates.find((update) => update.phase === 'settled')).toMatchObject({ messageId: sent.exchangeId, status: 'interrupted' })
    } finally {
      plane.shutdown()
    }
  })

  test('a parent parked on its own limit receives every report once it resumes', async () => {
    const { backend, plane, orchestrator, updates } = await sessions()
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'part one', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      await backend.started(3)
      // The parent's own turn hits the limit and parks.
      backend.rateLimit('thread-2', inAnHour())
      backend.complete('thread-1', 'part one done')
      await until(() => updates.some((update) => update.phase === 'settled'))
      expect(orchestratorRuns(backend, 'thread-2')).toEqual([])

      expect(plane.resolveRateLimit({ session: { sessionId: 'solus-sender' } } as IpcContext, 'send_now')).toBe(true)
      // The parent's own parked turn runs first; the report waits behind it.
      await backend.run((request) => request.conversation?.kind === 'resume' && request.conversation.threadId === 'thread-2' && request.prompt === 'coordinate')
      await until(() => backend.handles.has('thread-2'))
      backend.complete('thread-2', 'coordinated')
      await orchestratorRun(backend, 'thread-2')
      expect(reportsIn(orchestratorRuns(backend, 'thread-2')[0]!).map((report) => report.reply)).toEqual(['part one done'])
    } finally {
      plane.shutdown()
    }
  })
})

// WHY: an answer is a person's decision for one session. Delivered to another
// session, it runs that session's tool or picks its branch without anyone
// having seen the question — so the host sends it only to the session that is
// waiting on that exact question, once, while its turn still waits.
describe('answer routing', () => {
  const questions = [{ id: 'branch', question: 'Which branch?', options: [{ label: 'main' }], multiSelect: false }]

  test('an answer goes only to the session waiting on that question, and only once', async () => {
    const { backend, plane, orchestrator } = await sessions({ secondTarget: true })
    try {
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions })
      await until(() => plane.pendingInputEventsForSession('thread-1').length === 1)

      // Named for a session that is not waiting on it: refused, nothing reaches a provider.
      expect(orchestrator.mayAnswer('solus-second', 'thread-3')).toBe(true)
      expect(plane.respondToQuestion('thread-3', 'q1', { branch: 'main' })).toBe(false)
      expect(backend.permissions.questionAnswers).toEqual([])

      expect(plane.respondToQuestion('thread-1', 'q1', { branch: 'main' })).toBe(true)
      expect(backend.permissions.questionAnswers).toEqual([{ questionId: 'q1', answers: { branch: 'main' } }])

      // The other surface answers second: refused, the first answer stands.
      expect(plane.respondToQuestion('thread-1', 'q1', { branch: 'dev' })).toBe(false)
      expect(backend.permissions.questionAnswers).toHaveLength(1)
    } finally {
      plane.shutdown()
    }
  })

  test('a permission answer is refused for another session and after its turn ended', async () => {
    const { backend, plane } = await sessions({ secondTarget: true })
    try {
      backend.send('thread-1', {
        type: 'permission_request', questionId: 'p1', toolName: 'Bash', toolInput: { command: 'rm -rf build' },
        options: [{ id: 'allow', kind: 'allow', label: 'Allow' }, { id: 'deny', kind: 'deny', label: 'Deny' }],
      })
      await until(() => plane.pendingInputEventsForSession('thread-1').length === 1)
      expect(plane.respondToPermission('solus-second', 'p1', 'allow')).toBe(false)
      expect(backend.permissions.permissionAnswers).toEqual([])

      // The turn ends while the request waits: the answer has nothing left to reach.
      backend.complete('thread-1', 'gave up')
      await until(() => !plane.isSessionBusy('solus-target'))
      expect(plane.respondToPermission('solus-target', 'p1', 'allow')).toBe(false)
      expect(backend.permissions.permissionAnswers).toEqual([])
    } finally {
      plane.shutdown()
    }
  })

  test('a conversation may answer only its own requests and those of a session it sent work to', async () => {
    const { backend, plane, orchestrator } = await sessions({ secondTarget: true })
    try {
      await orchestrator.send('thread-2', 'thread-1', { prompt: 'which branch?', delivery: 'queue', notify: true })
      backend.complete('thread-1', 'first')
      await backend.started(4)
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions })
      await until(() => orchestrator.exchangesSentBy('solus-sender').some((message) => message.state === 'awaiting_input'))
      expect(orchestrator.mayAnswer('solus-sender', 'thread-1')).toBe(true)
      expect(orchestrator.mayAnswer('solus-sender', 'solus-target')).toBe(true)
      // A session the sender sent nothing to, and a session that sent nothing.
      expect(orchestrator.mayAnswer('solus-sender', 'thread-3')).toBe(false)
      expect(orchestrator.mayAnswer('solus-second', 'thread-1')).toBe(false)
    } finally {
      plane.shutdown()
    }
  })
})

function planEvent(): Extract<NormalizedEvent, { type: 'plan' }> {
  return {
    type: 'plan',
    planContent: '# Ship the parser\n\n1. Parse\n2. Test',
    planFilePath: '',
    questionId: 'plan-q',
    planToolUseId: 'tool-plan',
    options: [
      { id: 'allow-plan', kind: 'allow', label: 'Approve' },
      { id: 'deny-plan', kind: 'deny', label: 'Keep planning' },
    ],
  }
}
