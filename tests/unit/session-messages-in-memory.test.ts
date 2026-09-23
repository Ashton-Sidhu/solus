import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentConversationUpdate, AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'

// WHY: stage 2 of plans/003-session-message-integration.md. While the host
// runs, a message one session sends another must reach the sender's card
// before anything can answer it, every answer and reply must name that
// message, a reloaded card must be able to ask which messages are still live,
// and a parent must hear when a restart killed the child it delegated to.

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ControlPlaneModule = typeof import('@solus/server/control-plane')
type DbModule = typeof import('@solus/server/db')
type IndexerModule = typeof import('@solus/server/db/session-indexer')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let controlPlaneModule: ControlPlaneModule
let db: DbModule
let indexer: IndexerModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-messages-'))
  process.env.SOLUS_DATA_DIR = dataDir
  controlPlaneModule = await import('@solus/server/control-plane')
  db = await import('@solus/server/db')
  indexer = await import('@solus/server/db/session-indexer')
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
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return true }
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

  /** Resolves once the backend has been asked for `count` runs. */
  started(count: number): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve()
    return new Promise((resolve) => this.startWaiters.push({ count, resolve }))
  }

  startRun(request: AgentRunRequest): RunHandle {
    this.requests.push(request)
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
      for (const waiter of this.startWaiters.filter((candidate) => this.requests.length >= candidate.count)) waiter.resolve()
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
  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(): boolean { return false }
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
  for (let turn = 0; turn < 200 && !ready(); turn++) await new Promise((resolve) => setImmediate(resolve))
  expect(ready()).toBe(true)
}

/** A target (thread-1) and a caller (thread-2), both with a turn open. */
async function twoSessions() {
  const backend = new Backend()
  const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
  plane.on('error', () => {})
  const updates: AgentConversationUpdate[] = []
  plane.on('event', (sessionId: string, event: NormalizedEvent) => {
    if (sessionId === 'solus-caller' && event.type === 'agent_conversation_update') updates.push(event.update)
  })
  const target = await plane.runTurn({
    target: { kind: 'new-session' }, sessionId: 'solus-target', input: input(), tools: [],
    options: { prompt: 'start', promptSource: 'agent', skipTaskCreation: true },
  })
  await target.agentSessionId
  const caller = await plane.runTurn({
    target: { kind: 'new-session' }, sessionId: 'solus-caller', input: input(), tools: [],
    options: { prompt: 'coordinate', promptSource: 'agent', skipTaskCreation: true },
  })
  await caller.agentSessionId
  return { backend, plane, updates }
}

describe('session messages while the host runs', () => {
  test('a queued message is on the sender card before its reply, and the host carries it until it settles', async () => {
    const { backend, plane, updates } = await twoSessions()
    try {
      const result = await plane.promptSession('thread-1', 'follow up', 'queue', {
        reply: { messageId: 'm1', dispatchedAt: Date.now(), notifyModel: false, callerAgentSessionId: 'solus-caller' },
      })
      expect(result.disposition).toBe('queued')
      expect(updates.map((update) => update.phase)).toEqual(['dispatched'])
      expect(updates[0]).toMatchObject({ messageId: 'm1', agentSessionId: 'thread-1', prompt: 'follow up' })
      expect(plane.sessionMessagesSentBy('solus-caller')).toEqual([
        { messageId: 'm1', targetAgentSessionId: 'thread-1', state: 'queued' },
      ])

      // The first turn ends; the queued message becomes the running turn.
      backend.complete('thread-1', 'first')
      await backend.started(3)
      // Named by the sender's provider thread, the same messages come back.
      expect(plane.sessionMessagesSentBy('thread-2')).toEqual([
        { messageId: 'm1', targetAgentSessionId: 'thread-1', state: 'running' },
      ])
      expect(updates.map((update) => update.phase)).toEqual(['dispatched'])

      backend.complete('thread-1', 'second')
      await until(() => updates.length === 2)
      expect(updates[1]).toMatchObject({ phase: 'settled', messageId: 'm1', status: 'completed', replyText: 'second' })
      expect(plane.sessionMessagesSentBy('solus-caller')).toEqual([])
    } finally {
      plane.shutdown()
    }
  })

  test('an answer from any surface marks the message its turn was parked on', async () => {
    const { backend, plane, updates } = await twoSessions()
    try {
      expect(plane.watchSessionSettled('thread-1', 'solus-caller', { messageId: 'm2', dispatchedAt: Date.now(), notifyModel: false })).toBe(true)
      const questions = [{ id: 'branch', question: 'Which branch?', options: [{ label: 'main' }], multiSelect: false }]
      backend.send('thread-1', { type: 'question_request', questionId: 'q1', questions })
      await until(() => updates.some((update) => update.phase === 'awaiting_input'))
      expect(updates.find((update) => update.phase === 'awaiting_input')).toMatchObject({ messageId: 'm2', questionId: 'q1', answerKey: 'branch' })
      // A reloaded card learns the question it can answer from the host.
      expect(plane.sessionMessagesSentBy('solus-caller')).toEqual([{
        messageId: 'm2', targetAgentSessionId: 'thread-1', state: 'awaiting_input',
        question: { kind: 'question', text: 'Which branch?', questionId: 'q1', answerKey: 'branch' },
      }])

      // The same call a card, a person in the child's tab, or answer_session makes.
      expect(plane.respondToQuestion('q1', { branch: 'main' })).toBe(true)
      expect(updates.find((update) => update.phase === 'answered')).toEqual({
        phase: 'answered', agentSessionId: 'thread-1', messageId: 'm2', answerText: 'Which branch? → main',
      })
    } finally {
      plane.shutdown()
    }
  })

  test('a message to a session that does not exist is refused before it reaches the card', async () => {
    const { plane, updates } = await twoSessions()
    try {
      await expect(plane.promptSession('thread-missing', 'hello', 'queue', {
        reply: { messageId: 'm3', dispatchedAt: Date.now(), notifyModel: false, callerAgentSessionId: 'solus-caller' },
      })).rejects.toThrow()
      // Refused before acceptance: nothing to show, nothing carried.
      expect(updates).toEqual([])
      expect(plane.sessionMessagesSentBy('solus-caller')).toEqual([])
    } finally {
      plane.shutdown()
    }
  })

  test('a restart tells a delegating parent its child was interrupted, and only a delegating one', async () => {
    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    plane.on('error', () => {})
    try {
      const cwd = process.cwd()
      indexer.persistIndexedSessionStart('thread-parent', 'codex', cwd, cwd, 'gpt-test', 'medium')
      indexer.persistIndexedSessionStart('thread-child', 'codex', cwd, cwd, 'gpt-test', 'medium', null, null, {
        parentSessionId: 'thread-parent', messageId: 'm0', intent: 'delegate', createdAt: Date.now(),
      })
      indexer.persistIndexedSessionStart('thread-launched', 'codex', cwd, cwd, 'gpt-test', 'medium', null, null, {
        parentSessionId: 'thread-parent', messageId: 'm9', intent: 'fire_and_forget', createdAt: Date.now(),
      })

      plane.reportChildrenInterruptedByRestart(['thread-launched', 'thread-child'])
      await backend.started(1)
      const report = backend.requests[0]
      expect(report.conversation).toEqual({ kind: 'resume', threadId: 'thread-parent' })
      expect(report.prompt).toStartWith('[session report] Session thread-child finished (status: interrupted).')
    } finally {
      plane.shutdown()
    }
  })
})
