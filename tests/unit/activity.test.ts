import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Activity } from '@solus/contracts/activity'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/012-user-actor-and-activity.md §5: one activity record for what happened
// to a session or a task. A session's activity reaches everyone watching live and
// comes back with the history after a reload, at its place; task events moved onto
// it, and the task timeline reads the same rows, now with attributions.

let dataDir: string
let db: typeof import('@solus/server/db')
let activityModule: typeof import('@solus/server/data/activity/activity')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')
let hostUser: typeof import('@solus/server/host/host-user')
let sessionRuntimeModule: typeof import('@solus/server/execution/session-runtime')
let actors: typeof import('./helpers/actors')
let migrationsFolder: typeof import('@solus/server/db/migration-files').migrationsFolder
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-activity-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  activityModule = await import('@solus/server/data/activity/activity')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  hostUser = await import('@solus/server/host/host-user')
  sessionRuntimeModule = await import('@solus/server/execution/session-runtime')
  actors = await import('./helpers/actors')
  ;({ migrationsFolder } = await import('@solus/server/db/migration-files'))
})

const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const BOB = { id: { kind: 'account' as const, accountId: 'bob' }, displayName: 'Bob' }

describe('the activity record', () => {
  test('a subject reads its own rows oldest first, only in scope; a person reads what they did since', async () => {
    const { appendActivity, activityFor, newActivity } = activityModule
    const session = { kind: 'session' as const, id: 's1' }
    await appendActivity('local', newActivity(session, { kind: 'user', user: BOB }, { kind: 'renamed', title: 'Two' }, 20))
    await appendActivity('local', newActivity(session, { kind: 'user', user: BOB }, { kind: 'stopped' }, 10))
    await appendActivity('org-1', newActivity(session, { kind: 'system' }, { kind: 'rate_limit_decided', action: 'wait' }, 15))
    await appendActivity('local', newActivity({ kind: 'session', id: 's2' }, { kind: 'user', user: BOB }, { kind: 'stopped' }, 30))

    expect((await activityFor('local', session)).map((entry) => [entry.kind, entry.at])).toEqual([['stopped', 10], ['renamed', 20]])
    // The task feed's cap keeps the newest rows, still oldest first.
    expect((await activityFor('local', session, { limit: 1 })).map((entry) => entry.kind)).toEqual(['renamed'])
    expect((await activityFor('local', { userId: BOB.id, since: 15 })).map((entry) => [entry.subject.id, entry.kind])).toEqual([['s1', 'renamed'], ['s2', 'stopped']])
  })

  test('the history read places each activity before the first message after it', () => {
    const stop = (time: number): Activity => ({ kind: 'stopped', id: `stopped-${time}`, subject: { kind: 'session', id: 's' }, at: time, by: { kind: 'system' } })
    const messages = [
      { role: 'user', content: 'go', timestamp: 10 },
      { role: 'assistant', content: 'on it', timestamp: 12 },
      { role: 'user', content: 'next', timestamp: 20 },
    ]
    const merged = activityModule.mergeSessionActivity(messages, [stop(13), stop(25)])
    expect(merged.map((message) => message.activity?.id ?? message.content)).toEqual(['go', 'on it', 'stopped-13', 'next', 'stopped-25'])
    expect(merged[2]).toMatchObject({ role: 'system', messageId: 'activity:stopped-13', timestamp: 13 })
  })
})

/** A backend with one provider thread whose history is read in pages of one user turn. */
function historyBackend(history: SessionLoadMessage[]) {
  const pages = [history.filter((message) => message.timestamp < 20), history.filter((message) => message.timestamp >= 20)]
  return Object.assign(new EventEmitter(), {
    id: 'claude-code' as const,
    metadata: { id: 'claude-code' as const, label: 'Claude', models: [], defaultModel: '' },
    permissions: { getPendingInfo: () => undefined, respondToPermission: () => false, respondToQuestion: () => false, clearPendingForSession: () => {}, setCurrentSessionId: () => {} },
    getEnrichedError: () => ({ message: '', stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 }),
    isSessionRunning: () => false,
    getSessionHandle: () => undefined,
    cancelSession: () => false,
    getPendingHandles: () => [],
    shutdown: () => {},
    loadSession: async () => history,
    loadSessionPage: async (_sessionId: string, _projectPath: string | undefined, _turnLimit: number, before?: string) =>
      before === 'older' ? { messages: pages[0], before: null } : { messages: pages[1], before: 'older' },
  })
}

type HistoryHandler = (args: unknown[], ctx: unknown) => Promise<unknown>

async function historyHost(history: SessionLoadMessage[]) {
  const backend = historyBackend(history)
  const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend as never]]))
  runtime.on('error', () => {})
  cleanups.push(() => runtime.shutdown())
  const handlers = new Map<string, HistoryHandler>()
  const { registerHistoryHandlers } = await import('@solus/server/transport/handlers/history-handlers')
  registerHistoryHandlers({ register: (method: string, handler: HistoryHandler) => { handlers.set(method, handler) } } as never, {
    sessionRuntime: runtime,
    events: { broadcast: () => {} } as never,
    agentIdFromContext: () => 'claude-code',
    exchangeProgress: () => undefined,
  })
  const { TEST_HANDLER_CTX } = await import('./helpers/handler-ctx')
  const call = <T>(method: string, args: unknown[], ctx: unknown = TEST_HANDLER_CTX) => handlers.get(method)!(args, ctx) as Promise<T>
  return { runtime, call }
}

describe('a session activity', () => {
  const history: SessionLoadMessage[] = [
    { role: 'user', content: 'first', timestamp: 10 },
    { role: 'assistant', content: 'one', timestamp: 11 },
    { role: 'user', content: 'second', timestamp: 20 },
    { role: 'assistant', content: 'two', timestamp: 21 },
  ]

  test('reaches everyone watching, as it happens, and survives a reload at its place', async () => {
    const { runtime, call } = await historyHost(history)
    const sent: Array<{ event: NormalizedEvent; to?: { only?: string; except?: string } }> = []
    runtime.on('event', (_sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }) => { sent.push({ event, to }) })

    // Bob stops the first turn (a teammate of the reader).
    const stopped = await runtime.recordActivity({ kind: 'session', id: 'thread-1' }, actors.memberActor('bob', 'Bob'), { kind: 'stopped' })
    // Live: one broadcast to every client watching the session, the teammate included.
    expect(sent).toEqual([{ event: { type: 'activity', activity: stopped }, to: undefined }])
    expect(stopped).toMatchObject({ kind: 'stopped', by: { kind: 'user', user: { id: { kind: 'account', accountId: 'bob' } } } })

    // A reload reads the same activity back, inside the turn it happened in.
    const row = { ...stopped, at: 15 }
    const { getDatabase } = await import('@solus/server/db/database')
    const { sql } = await import('drizzle-orm')
    await getDatabase().run(sql`UPDATE activity SET at = 15 WHERE id = ${stopped.id}`)
    const loaded = await call<Array<{ content: string; activity?: Activity }>>('loadSession', ['thread-1', '/tmp/project', undefined, 'claude-code'])
    expect(loaded.map((message) => message.activity ? `activity:${message.activity.kind}` : message.content)).toEqual(['first', 'one', 'activity:stopped', 'second', 'two'])
    expect(loaded[2].activity).toEqual(row)
  })

  test('history pages hold each activity once, in the page it happened in', async () => {
    const { runtime, call } = await historyHost(history)
    const bob = actors.memberActor('bob', 'Bob')
    const early = await runtime.recordActivity({ kind: 'session', id: 'thread-1' }, bob, { kind: 'renamed', title: 'A' })
    const late = await runtime.recordActivity({ kind: 'session', id: 'thread-1' }, bob, { kind: 'renamed', title: 'B' })
    const { getDatabase } = await import('@solus/server/db/database')
    const { sql } = await import('drizzle-orm')
    await getDatabase().run(sql`UPDATE activity SET at = 15 WHERE id = ${early.id}`)
    await getDatabase().run(sql`UPDATE activity SET at = 25 WHERE id = ${late.id}`)

    const request = { sessionId: 'thread-1', provider: 'claude-code', turnLimit: 1 }
    const newest = await call<{ messages: Array<{ content: string; activity?: Activity }>; before: string | null }>('loadSessionPage', [request])
    expect(newest.messages.map((message) => message.activity?.id ?? message.content)).toEqual(['second', 'two', late.id])
    const older = await call<{ messages: Array<{ content: string; activity?: Activity }>; before: string | null }>('loadSessionPage', [{ ...request, before: newest.before! }])
    expect(older.messages.map((message) => message.activity?.id ?? message.content)).toEqual(['first', 'one', early.id])
    expect(older.before).toBeNull()
  })
})

describe('a session rename', () => {
  test('is activity only when the name changes, however many clients send it', async () => {
    const { call } = await historyHost([])
    const { cacheIndexedSessions } = await import('@solus/server/db/session-indexer')
    await cacheIndexedSessions([{ sessionId: 'thread-1', provider: 'claude-code', cwd: '/tmp/project', projectPath: '/tmp/project', firstMessage: 'go', lastTimestamp: 1, size: 1 } as never])
    const renames = () => activityModule.activityFor('local', { kind: 'session', id: 'thread-1' })
    const bob = actors.memberActor('bob', 'Bob')
    const rename = (title: string) => call('setSessionTitle', ['thread-1', title, 'manual'], { clientId: 'bob', principal: bob.principal, actor: bob })

    await rename('Spec')
    // Each client re-persists a name typed before the session had an id.
    await rename('Spec')
    await rename(' Spec ')
    await rename('Plan')
    await new Promise((resolve) => setImmediate(resolve))

    expect((await renames()).map((entry) => entry.kind === 'renamed' && entry.title)).toEqual(['Spec', 'Plan'])
  })

  test('an agent naming the session is not activity, nor is a client re-sending that name', async () => {
    const { call } = await historyHost([])
    const { cacheIndexedSessions } = await import('@solus/server/db/session-indexer')
    await cacheIndexedSessions([{ sessionId: 'thread-1', provider: 'claude-code', cwd: '/tmp/project', projectPath: '/tmp/project', firstMessage: 'go', lastTimestamp: 1, size: 1 } as never])
    const bob = actors.memberActor('bob', 'Bob')
    const ctx = { clientId: 'bob', principal: bob.principal, actor: bob }

    await call('setSessionTitle', ['thread-1', 'Fix login', 'generated'], ctx)
    // A reopened tab reads the stored name as custom and persists it again at the next init.
    await call('setSessionTitle', ['thread-1', 'Fix login', 'manual'], ctx)
    await new Promise((resolve) => setImmediate(resolve))

    expect(await activityModule.activityFor('local', { kind: 'session', id: 'thread-1' })).toEqual([])
  })
})

describe('task changes on the activity record', () => {
  test('a new task change is a `task_changed` activity with its doer, and goes with its task', async () => {
    const by = { kind: 'user' as const, user: BOB }
    const task = await taskStore.createTask('local', { title: 'New' }, undefined, by)
    const entity = await tasks.Task.byId('local', task.id)
    await entity.update({ status: 'todo' }, by)
    expect((await entity.details()).activity.map((entry) => entry.kind === 'task_changed' && [entry.change, entry.by])).toEqual([['created', by], ['status_changed', by]])
    await entity.delete()
    expect(await activityModule.activityFor('local', { kind: 'task', id: task.id })).toEqual([])
  })
})
