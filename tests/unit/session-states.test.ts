import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * The host holds where a session is in a person's list: active, settled, or
 * snoozed (docs/plans/session-pull-requests.md). A session settles when its
 * work ends, and a prompt makes it active again.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const PERSON = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }
const REPOSITORY = 'github.com/acme/solus'
const url = (number: number) => `https://github.com/acme/solus/pull/${number}`
const MINUTE = 60_000
const at = (ms: number) => new Date(ms).toISOString()
const notBusy = () => false

let dataDir: string
let db: typeof import('@solus/server/db')
let states: typeof import('@solus/server/data/sessions/session-states')
let sessionPrs: typeof import('@solus/server/data/sessions/session-pull-requests')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-states-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  states = await import('@solus/server/data/sessions/session-states')
  sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function stateOf(sessionId: string) {
  return (await states.readSessionShelf('local', [sessionId]))[0] ?? null
}

/** Link a pull request and record what PR sync saw of it. */
async function linked(sessionId: string, number: number, state: 'open' | 'merged' | 'closed', updatedAt: number) {
  await sessionPrs.linkSessionPullRequest(sessionId, { url: url(number), source: 'manual', by: PERSON })
  // SAFETY: the store reads only these fields of a pull request.
  await sessionPrs.recordSessionPullRequestObservation(REPOSITORY, number, { title: '', state, draft: false, updatedAt: at(updatedAt) } as never)
}

describe('a person settles and snoozes a session', () => {
  test('settle and its reverse, and each change is announced once', async () => {
    const changed: string[] = []
    const stop = states.onSessionStateChanged((sessionId) => changed.push(sessionId))
    try {
      expect(await states.settleSession('session-1', 'person', 100)).toBe(true)
      expect(await states.settleSession('session-1', 'person', 200)).toBe(false)
      expect(await stateOf('session-1')).toMatchObject({ settledAt: 100, settledBy: 'person' })
      expect(await states.unsettleSession('session-1')).toBe(true)
      expect(await stateOf('session-1')).toBeNull()
    } finally {
      stop()
    }
    expect(changed).toEqual(['session-1', 'session-1'])
  })

  test('a settled session is not snoozed, and a snooze can be ended', async () => {
    await states.snoozeSession('session-1', 5_000, ' after the deploy ')
    expect(await stateOf('session-1')).toMatchObject({ snoozedUntil: 5_000, snoozeNote: 'after the deploy', settledAt: null })
    await states.settleSession('session-1', 'person')
    expect(await stateOf('session-1')).toMatchObject({ snoozedUntil: null, snoozeNote: null })

    await states.snoozeSession('session-2', 5_000)
    await states.snoozeSession('session-2', null)
    expect(await stateOf('session-2')).toBeNull()
  })

  test('a prompt makes a settled or snoozed session active', async () => {
    // WHY: a person who writes to a session again is working in it. A list
    // that kept it under Completed would hide live work.
    await states.settleSession('session-1', 'pull-request')
    await states.recordSessionPrompt('session-1')
    expect(await stateOf('session-1')).toBeNull()

    await states.snoozeSession('session-2', Date.now() + MINUTE)
    await states.recordSessionPrompt('session-2')
    expect(await stateOf('session-2')).toBeNull()
  })

  test('the default list is what a client shelves: recent settles and every snooze', async () => {
    // WHY: a snooze that ended stays listed, so a client can show that the
    // session woke until a person opens it.
    const now = 1_000 * 24 * 60 * MINUTE
    await states.settleSession('recent', 'person', now - MINUTE)
    await states.settleSession('long-ago', 'person', now - states.SETTLED_SHELF_MS - MINUTE)
    await states.snoozeSession('asleep', now + MINUTE)
    await states.snoozeSession('woke', now - MINUTE)

    const listed = (await states.readSessionShelf('local', undefined, now)).map((entry) => entry.sessionId).sort()
    expect(listed).toEqual(['asleep', 'recent', 'woke'])
  })
})

describe('pull requests settle their session', () => {
  test('when every pull request has ended after the last prompt', async () => {
    // WHY: the work of a session is done when its pull requests are merged or
    // closed. One that is still open is work in progress.
    await states.recordSessionPrompt('session-1', 10 * MINUTE)
    await linked('session-1', 7, 'merged', 20 * MINUTE)
    await linked('session-1', 8, 'open', 20 * MINUTE)
    expect(await states.settleSessionsWithEndedPullRequests(notBusy)).toEqual([])

    await linked('session-1', 8, 'closed', 30 * MINUTE)
    expect(await states.settleSessionsWithEndedPullRequests(notBusy)).toEqual(['session-1'])
    expect(await stateOf('session-1')).toMatchObject({ settledBy: 'pull-request' })
  })

  test('not while the session runs, and not for a prompt that came after the merge', async () => {
    await linked('busy', 7, 'merged', 20 * MINUTE)
    expect(await states.settleSessionsWithEndedPullRequests((sessionId) => sessionId === 'busy')).toEqual([])

    // A person went on working after the merge: the merge is old news.
    await linked('follow-up', 9, 'merged', 20 * MINUTE)
    await states.recordSessionPrompt('follow-up', 25 * MINUTE)
    expect(await states.settleSessionsWithEndedPullRequests(notBusy)).toEqual(['busy'])
  })

  test('a session a person made active again stays active until a pull request ends later', async () => {
    await linked('session-1', 7, 'merged', 20 * MINUTE)
    await states.settleSessionsWithEndedPullRequests(notBusy)
    await states.unsettleSession('session-1', 25 * MINUTE)
    expect(await states.settleSessionsWithEndedPullRequests(notBusy)).toEqual([])

    await linked('session-1', 8, 'merged', 30 * MINUTE)
    expect(await states.settleSessionsWithEndedPullRequests(notBusy)).toEqual(['session-1'])
  })

  test('a removed link does not count', async () => {
    await linked('session-1', 7, 'merged', 20 * MINUTE)
    await linked('session-1', 8, 'open', 20 * MINUTE)
    await sessionPrs.unlinkSessionPullRequest('session-1', REPOSITORY, 8)
    expect(await states.settleSessionsWithEndedPullRequests(notBusy)).toEqual(['session-1'])
  })
})

describe('idle sessions', () => {
  test('settle after a long time with no prompt, unless a pull request is still open', async () => {
    const now = states.SESSION_IDLE_MS * 3
    await states.recordSessionPrompt('idle', now - states.SESSION_IDLE_MS - MINUTE)
    await states.recordSessionPrompt('recent', now - MINUTE)
    await states.recordSessionPrompt('waits-on-review', now - states.SESSION_IDLE_MS - MINUTE)
    await linked('waits-on-review', 7, 'open', now - states.SESSION_IDLE_MS)

    expect(await states.settleIdleSessions(notBusy, now)).toEqual(['idle'])
    expect(await stateOf('idle')).toMatchObject({ settledBy: 'idle' })
  })
})

describe('a task and the state of its sessions', () => {
  test('finishing a task settles its sessions, and reopening it makes them active', async () => {
    // WHY: PR sync watches a pull request while its session is live work. The
    // sessions of a finished task are not.
    const created = await taskStore.createTask('local', { title: 'Ship it', status: 'todo' })
    const task = await tasks.Task.byId('local', created.id)
    await task.linkSession('worker', 'working', {})
    await task.linkSession('reader', 'referenced', {})
    await states.settleSession('by-person', 'person')
    await task.linkSession('by-person', 'working', {})

    await task.update({ status: 'done' }, PERSON)
    expect(await stateOf('worker')).toMatchObject({ settledBy: 'task' })
    expect(await stateOf('reader')).toBeNull()

    await task.update({ status: 'in_progress' }, PERSON)
    expect(await stateOf('worker')).toBeNull()
    // What a person settled stays settled.
    expect(await stateOf('by-person')).toMatchObject({ settledBy: 'person' })
  })

  test('a session that another live task holds stays active', async () => {
    const first = await tasks.Task.byId('local', (await taskStore.createTask('local', { title: 'First', status: 'todo' })).id)
    const second = await tasks.Task.byId('local', (await taskStore.createTask('local', { title: 'Second', status: 'todo' })).id)
    await first.linkSession('shared', 'working', {})
    await second.linkSession('shared', 'working', {})

    await first.update({ status: 'done' }, PERSON)
    expect(await stateOf('shared')).toBeNull()
  })
})
