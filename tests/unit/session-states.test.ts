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
let records: typeof import('@solus/server/data/sessions/session-records')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-states-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  states = await import('@solus/server/data/sessions/session-states')
  sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  records = await import('@solus/server/data/sessions/session-records')
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

const shelf = (sessionId: string) => new states.SessionShelf(sessionId)

/** The session's state; null while it is active. */
async function stateOf(sessionId: string) {
  const state = await shelf(sessionId).state()
  return state.settledAt === null && state.snoozedUntil === null && state.archivedAt === null ? null : state
}

/** A session record last active at `lastActivityAt`. */
async function recorded(sessionId: string, lastActivityAt: number, parentSessionId: string | null = null) {
  await records.upsertSessionRecord('local', { sessionId, provider: 'codex', projectPath: '-repo', lastActivityAt, parentSessionId })
}

/** Link a pull request and record what PR sync saw of it. */
async function linked(sessionId: string, number: number, state: 'open' | 'merged' | 'closed', updatedAt: number) {
  await sessionPrs.linkSessionPullRequest(sessionId, { url: url(number), source: 'manual', by: PERSON })
  // SAFETY: the store reads only these fields of a pull request.
  await sessionPrs.recordSessionPullRequestObservation(REPOSITORY, number, { title: '', state, draft: false, updatedAt: at(updatedAt) } as never)
}

describe('a person settles and snoozes a session', () => {
  test('settle and its reverse, and each change is announced once with the state it leaves', async () => {
    const changed: Array<[string, number | null]> = []
    const stop = states.onSessionStateChanged((sessionId, state) => changed.push([sessionId, state.settledAt]))
    try {
      expect(await shelf('session-1').settle('person', 100)).toBe(true)
      expect(await shelf('session-1').settle('person', 200)).toBe(false)
      expect(await stateOf('session-1')).toMatchObject({ settledAt: 100, settledBy: 'person' })
      expect(await shelf('session-1').unsettle()).toBe(true)
      expect(await stateOf('session-1')).toBeNull()
    } finally {
      stop()
    }
    expect(changed).toEqual([['session-1', 100], ['session-1', null]])
  })

  test('a settled session is not snoozed, and a snooze can be ended', async () => {
    await shelf('session-1').snooze(5_000, ' after the deploy ')
    expect(await stateOf('session-1')).toMatchObject({ snoozedUntil: 5_000, snoozeNote: 'after the deploy', settledAt: null })
    await shelf('session-1').settle('person')
    expect(await stateOf('session-1')).toMatchObject({ snoozedUntil: null, snoozeNote: null })

    await shelf('session-2').snooze(5_000)
    await shelf('session-2').snooze(null)
    expect(await stateOf('session-2')).toBeNull()
  })

  test('archive keeps the shelf, and its reverse returns the session there', async () => {
    await shelf('session-1').snooze(5_000, 'after the deploy')
    expect(await shelf('session-1').archive(100)).toBe(true)
    expect(await shelf('session-1').archive(200)).toBe(false)
    expect(await stateOf('session-1')).toMatchObject({ archivedAt: 100, snoozedUntil: 5_000 })
    expect(await shelf('session-1').unarchive()).toBe(true)
    expect(await stateOf('session-1')).toMatchObject({ archivedAt: null, snoozedUntil: 5_000 })
    expect(await shelf('session-1').unarchive()).toBe(false)
  })

  test('a prompt makes a settled, snoozed, or archived session active', async () => {
    // WHY: a person who writes to a session again is working in it. A list
    // that kept it under Completed would hide live work.
    await shelf('session-1').settle('pull-request')
    await shelf('session-1').recordPrompt()
    expect(await stateOf('session-1')).toBeNull()

    await shelf('session-2').snooze(Date.now() + MINUTE)
    await shelf('session-2').recordPrompt()
    expect(await stateOf('session-2')).toBeNull()

    await shelf('session-3').archive()
    await shelf('session-3').recordPrompt()
    expect(await stateOf('session-3')).toBeNull()
  })
})

describe('pull requests settle their session', () => {
  test('when every pull request has ended after the last prompt', async () => {
    // WHY: the work of a session is done when its pull requests are merged or
    // closed. One that is still open is work in progress.
    await shelf('session-1').recordPrompt(10 * MINUTE)
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
    await shelf('follow-up').recordPrompt(25 * MINUTE)
    expect(await states.settleSessionsWithEndedPullRequests(notBusy)).toEqual(['busy'])
  })

  test('a session a person made active again stays active until a pull request ends later', async () => {
    await linked('session-1', 7, 'merged', 20 * MINUTE)
    await states.settleSessionsWithEndedPullRequests(notBusy)
    await shelf('session-1').unsettle(25 * MINUTE)
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
  test('are archived after a long time with no activity, unless a pull request is still open', async () => {
    // WHY: the archive bounds the session list. A session nothing ever put
    // away has no state row, and must leave the list too.
    const now = states.SESSION_IDLE_MS * 3
    const idleAt = now - states.SESSION_IDLE_MS - MINUTE
    await recorded('never-organized', idleAt)
    await recorded('recent', now - MINUTE)
    await recorded('waits-on-review', idleAt)
    await linked('waits-on-review', 7, 'open', idleAt)
    await recorded('snoozed-on', idleAt)
    await shelf('snoozed-on').snooze(now + MINUTE)
    await recorded('settled', idleAt)
    await shelf('settled').settle('person', idleAt)
    await recorded('busy', idleAt)

    expect((await states.archiveIdleSessions((sessionId) => sessionId === 'busy', now)).sort()).toEqual(['never-organized', 'settled'])
    expect(await stateOf('never-organized')).toMatchObject({ archivedAt: now, settledAt: null })
    // An archive keeps the shelf the session was on.
    expect(await stateOf('settled')).toMatchObject({ archivedAt: now, settledBy: 'person' })
    expect(await stateOf('recent')).toBeNull()
  })
})

describe('the archive migration', () => {
  test('archives each session idle for 30 days and spares an open pull request', async () => {
    // WHY: the list has no count limit, so the sessions nothing ever put away
    // must leave it before the first client reads it.
    const { readFileSync } = await import('node:fs')
    const { getDatabase } = await import('@solus/server/db/database')
    const { sql } = await import('drizzle-orm')
    const now = Date.now()
    await recorded('old', now - states.SESSION_IDLE_MS - MINUTE)
    await recorded('old-with-review', now - states.SESSION_IDLE_MS - MINUTE)
    await linked('old-with-review', 7, 'open', now - states.SESSION_IDLE_MS - MINUTE)
    await recorded('fresh', now - MINUTE)

    const file = readFileSync(join(import.meta.dir, '../../packages/server/drizzle/sqlite/0017_session_archive.sql'), 'utf8')
    const [, ...dataStatements] = file.split('--> statement-breakpoint')
    for (const statement of dataStatements) await getDatabase().run(sql.raw(statement))

    // SQLite's clock has whole seconds.
    expect((await stateOf('old'))?.archivedAt).toBeGreaterThanOrEqual(Math.floor(now / 1_000) * 1_000)
    expect(await stateOf('old-with-review')).toBeNull()
    expect(await stateOf('fresh')).toBeNull()
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
    await shelf('by-person').settle('person')
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

describe('the session list', () => {
  test('answers every root session in the list with its state, past any count, and the picker every session', async () => {
    // WHY: a client takes a session missing from the list as gone from it. A
    // count limit made a snoozed session come back active on each reload.
    const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
    const { ShareManager } = await import('@solus/server/sharing/share-manager')
    const { getDatabase } = await import('@solus/server/db/database')
    const operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
    const context = {
      principal: { kind: 'local-owner' as const, deviceId: null, deviceLabel: 'Mac' },
      home: { kind: 'local' as const, hostId: 'this-mac' },
      scopes: ['sessions:read' as const],
    }
    for (let index = 0; index < 520; index++) await recorded(`settled-${index}`, 10_000 + index)
    for (let index = 0; index < 520; index++) await shelf(`settled-${index}`).settle('person', 10_000 + index)
    await recorded('asleep', 1)
    await shelf('asleep').snooze(Date.now() + MINUTE)
    await recorded('archived', 2)
    await shelf('archived').archive()
    await recorded('child', 3, 'settled-0')

    const listed = new Map<string, { snoozedUntil: number | null } | null>()
    let cursor: string | undefined
    do {
      const page = await operations.list(context, { limit: 200, order: 'activity', archived: 'false', roots: 'true', cursor })
      for (const item of page.items) listed.set(item.id, item.state ?? null)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(listed.size).toBe(521)
    expect(listed.get('asleep')?.snoozedUntil).toBeGreaterThan(Date.now())
    expect(listed.has('archived')).toBe(false)
    expect(listed.has('child')).toBe(false)

    const archived = await operations.list(context, { limit: 50, archived: 'true' })
    expect(archived.items.map((item) => item.id)).toEqual(['archived'])
    expect(archived.items[0].state?.archivedAt).toEqual(expect.any(Number))
  })
})
