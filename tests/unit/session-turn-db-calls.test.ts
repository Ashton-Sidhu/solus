import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentBackend, RunHandle } from '@solus/server/agents/agent-backend'
import type { IpcContext, NormalizedEvent } from '@solus/contracts/types'
import { resetTestDatabase } from './helpers/test-db'

// WHY: every turn pays for its database calls on the host's one synchronous
// connection. This test is the budget: it counts the calls and commits one
// typed turn makes, so a change that adds a write to every turn fails here
// instead of shipping (plans/003-session-message-integration.md, stage 1).

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let dataDir = ''
let previousDataDir: string | undefined
let ControlPlane: typeof import('@solus/server/control-plane')['ControlPlane']
let SeatManager: typeof import('@solus/server/seats/seat-manager')['SeatManager']
let dbModule: typeof import('@solus/server/db/index')

interface Counted { calls: number; writes: number; commits: number; statements: string[] }
const counted: Counted = { calls: 0, writes: 0, commits: 0, statements: [] }
let transactionDepth = 0

function resetCount(): void {
  counted.calls = 0
  counted.writes = 0
  counted.commits = 0
  counted.statements = []
}

function record(text: string): void {
  const statement = text.trim().replace(/\s+/g, ' ')
  const verb = statement.split(' ')[0]?.toUpperCase() ?? ''
  if (verb === 'PRAGMA') return
  counted.calls++
  counted.statements.push(statement.slice(0, 80))
  if (verb === 'BEGIN') { transactionDepth = 1; return }
  if (verb === 'COMMIT') { transactionDepth = 0; counted.commits++; return }
  if (verb === 'ROLLBACK') { transactionDepth = 0; return }
  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(verb)) {
    counted.writes++
    if (transactionDepth === 0) counted.commits++
  }
}

// Wraps the host's one connection so every statement it runs is counted.
function countCalls(db: DatabaseSync): void {
  const connection = db as unknown as Database
  const prepare = connection.prepare.bind(connection)
  const exec = connection.exec.bind(connection)
  connection.exec = ((text: string) => { record(text); return exec(text) }) as Database['exec']
  connection.prepare = ((text: string) => {
    const statement = prepare(text)
    for (const method of ['run', 'get', 'all', 'values'] as const) {
      const original = statement[method].bind(statement)
      statement[method] = ((...args: never[]) => { record(text); return original(...args) }) as never
    }
    return statement
  }) as Database['prepare']
}

beforeAll(async () => {
  previousDataDir = process.env.SOLUS_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'solus-turn-db-calls-'))
  process.env.SOLUS_DATA_DIR = dataDir
  dbModule = await import('@solus/server/db/index')
  ;({ ControlPlane } = await import('@solus/server/control-plane'))
  ;({ SeatManager } = await import('@solus/server/seats/seat-manager'))
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

// A provider that behaves like Claude: every run, first or resumed, reports
// session_init for its thread, then finishes.
function backend() {
  const emitter = new EventEmitter() as EventEmitter & Pick<AgentBackend, 'id' | 'metadata' | 'permissions' | 'startRun' | 'getPendingHandles' | 'getSessionHandle' | 'isSessionRunning' | 'shutdown' | 'getEnrichedError' | 'cancelSession'>
  const handles = new Map<string, RunHandle>()
  let threads = 0
  emitter.id = 'claude-code'
  emitter.metadata = { id: 'claude-code', label: 'Claude', models: [], defaultModel: '' } as never
  emitter.permissions = { getPendingInfo: () => undefined, respondToPermission: () => false, respondToQuestion: () => false, clearPendingForSession: () => {}, setCurrentSessionId: () => {} }
  emitter.getEnrichedError = () => ({ message: '', stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
  emitter.startRun = (request: AgentRunRequest) => {
    const threadId = request.conversation?.kind === 'resume' ? request.conversation.threadId : `thread-${++threads}`
    let resolve!: () => void
    const runPromise = new Promise<void>((res) => { resolve = res })
    const handle: RunHandle = {
      agentSessionId: null,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise,
      _resolveRun: resolve,
      _rejectRun: () => {},
    }
    setImmediate(() => {
      handle.agentSessionId = threadId
      handles.set(threadId, handle)
      emitter.emit('normalized', threadId, { type: 'session_init', sessionId: threadId, model: 'fixture-model', skills: [] } satisfies NormalizedEvent)
      setImmediate(() => {
        handle.resultText = 'done'
        resolve()
        emitter.emit('exit', threadId, 0, null)
        handles.delete(threadId)
      })
    })
    return handle
  }
  emitter.getPendingHandles = () => []
  emitter.getSessionHandle = (threadId: string) => handles.get(threadId)
  emitter.isSessionRunning = (threadId: string) => handles.has(threadId)
  emitter.shutdown = () => {}
  emitter.cancelSession = () => false
  return emitter
}

function ctx(sessionId: string): IpcContext {
  return {
    session: { sessionId, provider: 'claude-code', agentSessionId: null, workingDirectory: dataDir, origin: 'user' },
    window: {},
    settings: { activeAgent: 'claude-code' },
    statusBar: { model: 'fixture-model', reasoningEffort: 'medium', permissionMode: 'auto' },
  } as unknown as IpcContext
}

// Fire-and-forget record writes chain on promises; drain them by event-loop
// turns, not by wall-clock time.
async function drain(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve))
}

async function typedTurn(plane: InstanceType<typeof ControlPlane>, sessionId: string, clientPromptId: string): Promise<void> {
  const owner = { clientId: 'c1', actor: { userId: 'host-owner', seatUserId: 'host-owner' } }
  await plane.submitPrompt(ctx(sessionId), { prompt: `turn ${clientPromptId}`, clientPromptId }, owner)
  await drain()
}

describe('database calls per typed turn', () => {
  test('a resumed typed turn stays within its call and commit budget', async () => {
    const db = dbModule.getDb()
    // Wrap before anything prepares a statement it will reuse.
    countCalls(db)
    const plane = new ControlPlane(new Map([['claude-code', backend() as never]]))
    const root = mkdtempSync(join(tmpdir(), 'solus-turn-db-seats-'))
    try {
      plane.useSeats(new SeatManager({ db, seatsRoot: join(root, 'seats'), hostClaudeDir: join(root, '.claude'), hostCodexHome: join(root, '.codex') }))
      resetCount()
      await typedTurn(plane, 's-budget', 'p1')
      await typedTurn(plane, 's-budget', 'p2')
      resetCount()
      await typedTurn(plane, 's-budget', 'p3')
      // A resumed turn in steady state: the record's status opens and closes
      // (2 writes), the turn's task binding is looked up (2 reads), and the
      // finished-attention summary reads the session index (1 read). Before
      // stage 1 this turn made 24 calls and 7 commits: lineage re-registration,
      // a no-op index upsert, a record upsert, repeated lineage, seat and goal
      // reads. The turn ledger's two writes had no reader and were removed.
      expect(counted.statements.map((statement) => statement.split(' ').slice(0, 3).join(' '))).toEqual([
        'UPDATE "session_records" SET',
        'SELECT task_id FROM',
        'SELECT tasks.*, task_external_links.provider',
        'SELECT session_id, provider,',
        'UPDATE "session_records" SET',
      ])
      expect({ calls: counted.calls, writes: counted.writes, commits: counted.commits }).toEqual({ calls: 5, writes: 2, commits: 2 })
    } finally {
      plane.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
