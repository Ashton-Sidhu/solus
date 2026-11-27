import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '@solus/server/execution/agents/agent-runner'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'
import type { ProviderHistoryPage, SessionLoadMessage } from '@solus/contracts/session-history'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/running-turn-open.md: a client that opens a session mid-turn reads
// the settled turns from the history and the running turn from the turn log
// alone. Claude and Codex have written part of the running turn to their own
// history already; ACP writes it when the turn ends. Either way the client must
// get the person's prompt exactly once, and the turn's work exactly once.

type SessionRuntimeModule = typeof import('@solus/server/execution/session-runtime')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let sessionRuntimeModule: SessionRuntimeModule
let db: typeof import('@solus/server/db')
let metricsDb: typeof import('@solus/server/data/insights/metrics-db')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-running-turn-open-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionRuntimeModule = await import('@solus/server/execution/session-runtime')
  db = await import('@solus/server/db')
  metricsDb = await import('@solus/server/data/insights/metrics-db')
})

afterEach(() => {
  metricsDb.closeMetricsDb()
  db.closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
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

const SETTLED: SessionLoadMessage[] = [
  { role: 'user', content: 'an earlier turn', timestamp: Date.now() - 60_000 },
  { role: 'assistant', content: 'its reply', timestamp: Date.now() - 59_000 },
]

/** A backend whose history holds the settled turn, and the running turn's rows when it writes as it goes. */
class Backend extends EventEmitter implements AgentBackend {
  readonly id = 'codex' as const
  readonly metadata: AgentMetadata = { id: 'codex', label: 'Codex', models: [], defaultModel: 'gpt-test' }
  readonly permissions = new Permissions()
  readonly handles = new Map<string, RunHandle>()
  /** Rows of the running turn on disk; null when the backend writes a turn only when it ends. */
  runningRows: SessionLoadMessage[] | null = []

  constructor(readonly writesAsItGoes: boolean) { super() }

  startRun(request: AgentRunRequest, sessionState?: AgentRunSessionState): RunHandle {
    const threadId = 'thread-1'
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: null, sessionId: sessionState?.sessionId, persistence: request.persistence,
      startedAt: Date.now(), toolCallCount: 0, sawPermissionRequest: false, permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>((res, rej) => { resolve = res; reject = rej }),
      _resolveRun: resolve, _rejectRun: reject,
    }
    queueMicrotask(() => {
      handle.agentSessionId = threadId
      this.handles.set(threadId, handle)
      if (this.writesAsItGoes) this.runningRows = [{ role: 'user', content: request.prompt, timestamp: Date.now() }]
      this.emit('normalized', threadId, { type: 'session_init', sessionId: threadId, model: 'gpt-test', skills: [] } satisfies NormalizedEvent)
    })
    return handle
  }

  /** The provider works: a tool call, which a provider that writes as it goes also writes. */
  work(): void {
    if (this.writesAsItGoes) this.runningRows!.push({ role: 'tool', content: '', toolId: 'tool-1', toolName: 'Read', toolStatus: 'completed', timestamp: Date.now() })
    this.emit('normalized', 'thread-1', { type: 'tool_call', toolName: 'Read', toolId: 'tool-1', index: 0 } satisfies NormalizedEvent)
  }

  complete(): void {
    const handle = this.handles.get('thread-1')!
    this.emit('normalized', 'thread-1', { type: 'task_complete', result: 'done', costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: 'thread-1' } satisfies NormalizedEvent)
    handle._resolveRun()
    this.handles.delete('thread-1')
    this.emit('exit', 'thread-1', 0, null)
  }

  async loadSessionPage(): Promise<ProviderHistoryPage> {
    return { messages: [...SETTLED, ...(this.writesAsItGoes ? this.runningRows ?? [] : [])], before: null }
  }

  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(): boolean { return false }
  isSessionRunning(sessionId: string): boolean { return this.handles.has(sessionId) }
  async steerSession(sessionId: string): Promise<RunHandle | null> { return this.handles.get(sessionId) ?? null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(): SessionRunInput {
  return {
    provider: 'codex', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    gitContext: null, worktreeBaseBranch: null, contextWindow: null,
    model: 'gpt-test', preferredModel: 'gpt-test', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

/** Open a running session as a new client does: watch, then read the page the watch fits. */
async function openMidTurn(writesAsItGoes: boolean) {
  const backend = new Backend(writesAsItGoes)
  const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['codex', backend]]))
  runtime.on('error', () => {})
  const sessionId = `running-${writesAsItGoes ? 'as-it-goes' : 'at-the-end'}`
  // The sender's own echo goes to everyone but the sender, as for a client with no prompt id.
  const lifecycle = await runtime.runTurn({
    target: { kind: 'new-session' }, sessionId, input: input(), tools: [], sourceClientId: 'sender',
    options: { prompt: 'the running prompt', promptSource: 'typed' },
  })
  await lifecycle.agentSessionId
  backend.work()
  const replay: NormalizedEvent[] = []
  runtime.on('event', (_id, event: NormalizedEvent, to?: { only?: string }) => { if (to?.only === 'joining') replay.push(event) })
  const watched = runtime.watchers.watchSession({ sessionId, attachRuntime: true }, 'joining')
  const page = await runtime.history.loadSessionPage({ sessionId, provider: 'codex', turnLimit: 10 }, undefined, watched.runningTurnStartedAt ?? null)
  return { backend, runtime, lifecycle, sessionId, replay, watched, page }
}

/** What the client shows: the page's rows, then the replayed prompts and tool calls. */
function shown(page: ProviderHistoryPage, replay: NormalizedEvent[]): string[] {
  return [
    ...page.messages.map((row) => row.role === 'tool' ? `tool:${row.toolId}` : `${row.role}:${row.content}`),
    ...replay.flatMap((event) => event.type === 'user_message' ? [`user:${event.text}`] : event.type === 'tool_call' ? [`tool:${event.toolId}`] : []),
  ]
}

describe.serial('opening a session mid-turn', () => {
  for (const writesAsItGoes of [true, false]) {
    test(`gives settled history and the whole running turn once (${writesAsItGoes ? 'history written as it goes' : 'history written at the end'})`, async () => {
      const { backend, runtime, lifecycle, page, replay, watched } = await openMidTurn(writesAsItGoes)
      try {
        expect(watched.runningTurnStartedAt).toBeNumber()
        expect(page.runningTurnStartedAt).toBe(watched.runningTurnStartedAt)
        expect(shown(page, replay)).toEqual([
          'user:an earlier turn', 'assistant:its reply',
          'user:the running prompt', 'tool:tool-1',
        ])
        backend.complete()
        await lifecycle.done
      } finally { runtime.shutdown() }
    })
  }

  test('a settled turn is history again: the page holds it whole and nothing replays', async () => {
    const { backend, runtime, lifecycle, sessionId } = await openMidTurn(true)
    try {
      backend.complete()
      await lifecycle.done
      const watched = runtime.watchers.watchSession({ sessionId, attachRuntime: true }, 'late')
      expect(watched.runningTurnStartedAt).toBeUndefined()
      const page = await runtime.history.loadSessionPage({ sessionId, provider: 'codex', turnLimit: 10 })
      expect(page.messages.map((row) => row.content)).toContain('the running prompt')
      expect(page.runningTurnStartedAt).toBeUndefined()
    } finally { runtime.shutdown() }
  })

  test('a page read without a watch leaves out the turn running now', async () => {
    const { backend, runtime, lifecycle, sessionId } = await openMidTurn(true)
    try {
      const page = await runtime.history.loadSessionPage({ sessionId, provider: 'codex', turnLimit: 10 })
      expect(page.messages.map((row) => row.content)).toEqual(['an earlier turn', 'its reply'])
      backend.complete()
      await lifecycle.done
    } finally { runtime.shutdown() }
  })

  test('a prompt after the turn settled, into a query that background work keeps open, starts the next turn', async () => {
    // The page cut and the replay start at the same prompt. A query held open by
    // background work takes the next prompt as a steer; when that steer joined the
    // settled turn, the "running turn" grew across every later prompt, the page
    // left out all of it, and the replay was only the tail of the turn log.
    const { backend, runtime, lifecycle, sessionId } = await openMidTurn(true)
    try {
      // The first turn ends with work left running, so the query stays open.
      for (const row of backend.runningRows!) row.timestamp -= 5_000
      backend.emit('normalized', 'thread-1', { type: 'background_task_started', taskId: 'task-1', awaitable: false } satisfies NormalizedEvent)
      backend.emit('normalized', 'thread-1', { type: 'task_complete', result: 'done', costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: 'thread-1' } satisfies NormalizedEvent)
      expect(runtime.turns.current(sessionId)?.isSettled).toBe(true)
      await runtime.runTurn({
        target: { kind: 'session', sessionId }, sessionId, input: { ...input(), agentSessionId: 'thread-1' }, tools: [],
        options: { prompt: 'the next prompt', promptSource: 'typed', clientPromptId: 'next' },
      })
      const prompts = runtime.turnLog.get(sessionId)!.filter((event) => event.type === 'user_message')
      // The next prompt starts the turn log, as a prompt: no client draws it inside the settled turn.
      expect(prompts.map((event) => event.type === 'user_message' && [event.text, event.delivery])).toEqual([['the next prompt', undefined]])
      backend.runningRows!.push({ role: 'user', content: 'the next prompt', timestamp: Date.now() })
      const replay: NormalizedEvent[] = []
      runtime.on('event', (_id, event: NormalizedEvent, to?: { only?: string }) => { if (to?.only === 'joining') replay.push(event) })
      const watched = runtime.watchers.watchSession({ sessionId, attachRuntime: true }, 'joining')
      const page = await runtime.history.loadSessionPage({ sessionId, provider: 'codex', turnLimit: 10 }, undefined, watched.runningTurnStartedAt ?? null)
      expect(shown(page, replay)).toEqual([
        'user:an earlier turn', 'assistant:its reply',
        'user:the running prompt', 'tool:tool-1',
        'user:the next prompt',
      ])
      backend.complete()
      await lifecycle.done
    } finally { runtime.shutdown() }
  })

  test('a long turn keeps its prompt when the turn log drops its oldest events', async () => {
    const { backend, runtime, lifecycle, sessionId } = await openMidTurn(false)
    try {
      for (let index = 0; index < 2100; index++) runtime.publish(sessionId, { type: 'assistant_message', text: `step ${index}` })
      const log = runtime.turnLog.get(sessionId)!
      expect(log.filter((event) => event.type === 'user_message').map((event) => event.type === 'user_message' && event.text)).toEqual(['the running prompt'])
      expect(runtime.runningTurnStartedAt(sessionId)).toBeNumber()
      backend.complete()
      await lifecycle.done
    } finally { runtime.shutdown() }
  })
})

describe('settledHistory', () => {
  test('cuts the trailing turns dated from the second the running prompt was recorded', async () => {
    const { settledHistory } = await import('@solus/server/execution/sessions/session-history')
    const startedAt = 1_000_500
    const rows: SessionLoadMessage[] = [
      { role: 'user', content: 'settled', timestamp: 990_000 },
      { role: 'assistant', content: 'reply', timestamp: 991_000 },
      // Codex dates the running turn by its start, in whole seconds.
      { role: 'user', content: 'running', timestamp: 1_000_000 },
      { role: 'user', content: 'steer', timestamp: 1_000_000 },
      { role: 'assistant', content: 'work', timestamp: 1_000_000 },
    ]
    expect(settledHistory(rows, startedAt, 2_000_000).map((row) => row.content)).toEqual(['settled', 'reply'])
  })

  test('a row dated after the read began has no date of its own and stays', async () => {
    const { settledHistory } = await import('@solus/server/execution/sessions/session-history')
    const rows: SessionLoadMessage[] = [
      { role: 'user', content: 'undated', timestamp: 2_000_100 },
      { role: 'assistant', content: 'reply', timestamp: 2_000_100 },
    ]
    expect(settledHistory(rows, 1_000_000, 2_000_000)).toBe(rows)
  })
})
