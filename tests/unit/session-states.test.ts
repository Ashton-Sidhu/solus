import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'
import { sql } from 'drizzle-orm'
import { EMPTY_SESSION_VIEW, SESSION_LIST_IDLE_MS } from '@solus/contracts/session-state'

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
  return state.settledAt === null ? null : state
}

const viewer = (sessionId: string, personKey: string) => new states.SessionViewer(sessionId, personKey)
const ALICE = 'user:alice'
const BOB = 'user:bob'

/** A session record last active at `lastActivityAt`, owned by `ownerKey` (docs/plans/access-model.md §2.2). */
async function recorded(sessionId: string, lastActivityAt: number, parentSessionId: string | null = null, ownerKey = ALICE) {
  await records.upsertSessionRecord('local', { sessionId, provider: 'codex', projectPath: '-repo', lastActivityAt, parentSessionId }, { organizationId: 'local', ownerKey })
}

/** Link a pull request and record what PR sync saw of it. */
async function linked(sessionId: string, number: number, state: 'open' | 'merged' | 'closed', updatedAt: number) {
  await sessionPrs.linkSessionPullRequest(sessionId, { url: url(number), source: 'manual', by: PERSON })
  // SAFETY: the store reads only these fields of a pull request.
  await sessionPrs.recordSessionPullRequestObservation(REPOSITORY, number, { title: '', state, draft: false, updatedAt: at(updatedAt) } as never)
}

describe('a session is settled for everyone, and archived or snoozed for one person', () => {
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

  test("one person's archive and snooze change their view, and nobody else's", async () => {
    // WHY: on a team, my archive or snooze must not hide the session from my
    // teammates. Each person's view is their own row.
    const heard: Array<[string, number | null]> = []
    const stop = states.onSessionViewChanged((change) => heard.push([change.personKey, change.view.archivedAt]))
    try {
      expect(await viewer('session-1', ALICE).archive(100)).toBe(true)
      expect(await viewer('session-1', ALICE).archive(200)).toBe(false)
      await viewer('session-1', ALICE).snooze(5_000, ' after the deploy ')
      expect(await viewer('session-1', ALICE).view()).toEqual({ archivedAt: 100, snoozedUntil: 5_000, snoozeNote: 'after the deploy' })
      expect(await viewer('session-1', BOB).view()).toEqual(EMPTY_SESSION_VIEW)

      // Return keeps the snooze: the session goes back to the shelf it left.
      expect(await viewer('session-1', ALICE).unarchive()).toBe(true)
      expect(await viewer('session-1', ALICE).view()).toMatchObject({ archivedAt: null, snoozedUntil: 5_000 })
      await viewer('session-1', ALICE).snooze(null)
      expect(await viewer('session-1', ALICE).view()).toEqual(EMPTY_SESSION_VIEW)
    } finally {
      stop()
    }
    expect(heard.every(([personKey]) => personKey === ALICE)).toBe(true)
    expect(heard[0]).toEqual([ALICE, 100])
  })

  test('a prompt makes a settled session active, and returns it to the list of the person it is for', async () => {
    // WHY: a person who writes to a session again is working in it. A teammate
    // who archived it keeps their own list.
    await shelf('session-1').settle('pull-request')
    await viewer('session-1', ALICE).archive()
    await viewer('session-1', BOB).archive()
    await viewer('session-1', ALICE).snooze(Date.now() + MINUTE)
    await shelf('session-1').recordPrompt(ALICE)
    expect(await stateOf('session-1')).toBeNull()
    expect(await viewer('session-1', ALICE).view()).toEqual(EMPTY_SESSION_VIEW)
    expect((await viewer('session-1', BOB).view()).archivedAt).not.toBeNull()
  })
})

describe('pull requests settle their session', () => {
  test('when every pull request has ended after the last prompt', async () => {
    // WHY: the work of a session is done when its pull requests are merged or
    // closed. One that is still open is work in progress.
    await shelf('session-1').recordPrompt(null, 10 * MINUTE)
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
    await shelf('follow-up').recordPrompt(null, 25 * MINUTE)
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

describe("a person's session list", () => {
  test('holds every root session they did not archive that is recent, snoozed by them, or waiting on an open pull request', async () => {
    // WHY: the list has no count limit; the idle rule and each person's own
    // archive bound it. A count limit made a snoozed session come back active
    // on each reload.
    const now = Date.now()
    const old = now - SESSION_LIST_IDLE_MS - MINUTE
    for (let index = 0; index < 520; index++) await recorded(`recent-${index}`, now - index)
    await recorded('archived-by-alice', now)
    await viewer('archived-by-alice', ALICE).archive()
    await recorded('old', old)
    await recorded('old-snoozed', old)
    await viewer('old-snoozed', ALICE).snooze(now + MINUTE)
    await recorded('old-with-review', old)
    await linked('old-with-review', 7, 'open', old)
    await recorded('child', now, 'recent-0')

    const listedFor = async (personKey: string) => {
      const listed = new Set<string>()
      let before = Number.MAX_SAFE_INTEGER
      for (;;) {
        const page = await records.readSessionMetadataPage(sql`session_records.parent_session_id IS NULL AND ${records.sessionListedClause({ personKey, now })} AND session_records.last_activity_at < ${before}`, 200, 'last_activity_at', { personKey, now })
        for (const record of page) listed.add(record.sessionId)
        if (page.length < 200) return listed
        before = page[page.length - 1]!.lastActivityAt
      }
    }
    const alice = await listedFor(ALICE)
    expect(alice.size).toBe(522)
    expect(alice.has('old-snoozed') && alice.has('old-with-review')).toBe(true)
    expect(alice.has('archived-by-alice') || alice.has('old') || alice.has('child')).toBe(false)
    // Alice owns them, so they are not Bob's until he prompts them. Then her archive and her snooze are not his.
    expect((await listedFor(BOB)).size).toBe(0)
    await shelf('archived-by-alice').recordPrompt(BOB)
    await shelf('old-snoozed').recordPrompt(BOB)
    const bob = await listedFor(BOB)
    expect(bob.has('archived-by-alice')).toBe(true)
    expect(bob.has('old-snoozed')).toBe(false)
  })

  test("a session someone else owns joins a person's list when they prompt it", async () => {
    // WHY: in an organization every member can see every session; each
    // person's list holds the ones they own or worked in, not everyone's.
    const now = Date.now()
    await recorded('alices', now, null, ALICE)
    const listed = async (personKey: string) => (await records.readSessionMetadataPage(sql`session_records.session_id = 'alices'`, 1, 'created_at', { personKey, now }))[0]?.listed
    expect(await listed(ALICE)).toBe(true)
    expect(await listed(BOB)).toBe(false)
    await shelf('alices').recordPrompt(BOB)
    expect(await listed(BOB)).toBe(true)
  })

  test('the API answers the list, and the sessions out of it, with the reader view', async () => {
    const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
    const { ShareManager } = await import('@solus/server/sharing/share-manager')
    const { getDatabase } = await import('@solus/server/db/database')
    const { hostUserKey } = await import('@solus/server/host/host-user')
    const operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
    const context = {
      principal: { kind: 'local-owner' as const, deviceId: null, deviceLabel: 'Mac' },
      home: { kind: 'local' as const, hostId: 'this-mac' },
      scopes: ['sessions:read' as const, 'sessions:write' as const],
    }
    await recorded('kept', Date.now())
    await recorded('put-away', Date.now())
    await operations.update(context, 'put-away', { archived: true })
    await operations.update(context, 'kept', { snoozedUntil: Date.now() + MINUTE, snoozeNote: 'later' })
    // A change to a session the home does not keep writes no view for it.
    await expect(operations.update(context, 'unknown', { archived: true })).rejects.toThrow('Resource not found.')
    expect((await viewer('unknown', hostUserKey()).view()).archivedAt).toBeNull()

    await recorded('started-by-kept', Date.now(), 'kept')
    // The default is the caller's list, top-level sessions only.
    const listed = await operations.list(context, { limit: 50 })
    expect(listed.items.map((item) => item.id)).toEqual(['kept'])
    expect(listed.items[0]).toMatchObject({ listed: true, view: { snoozeNote: 'later' }, pullRequests: [] })
    // `scope=all` answers every top-level session the caller reads, each marked.
    const all = await operations.list(context, { limit: 50, scope: 'all' })
    expect(all.items.map((item) => [item.id, item.listed]).sort()).toEqual([['kept', true], ['put-away', false]])
    expect(all.items.find((item) => item.id === 'put-away')?.view?.archivedAt).toEqual(expect.any(Number))
    // A session's own children, by its id.
    const children = await operations.list(context, { limit: 50, parentSessionId: 'kept' })
    expect(children.items.map((item) => item.id)).toEqual(['started-by-kept'])
    expect((await viewer('put-away', hostUserKey()).view()).archivedAt).not.toBeNull()

    const settled = await operations.update(context, 'kept', { settled: true })
    expect(settled.state?.settledBy).toBe('person')

    // A turn the session's machine reports, as the person it acts for, makes
    // the session active and returns it to that person's list.
    await expect(operations.admitTurn({ ...context, scopes: ['sessions:admit'] }, 'put-away')).rejects.toThrow('Only a host acting for a person')
    await operations.admitTurn({ ...context, scopes: ['sessions:admit'], delegation: { hostId: 'vm-1' } }, 'put-away')
    expect((await viewer('put-away', hostUserKey()).view()).archivedAt).toBeNull()
    await operations.admitTurn({ ...context, scopes: ['sessions:admit'], delegation: { hostId: 'vm-1' } }, 'kept')
    expect(await stateOf('kept')).toBeNull()
  })
})
