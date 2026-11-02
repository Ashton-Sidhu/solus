import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * `resource_links`: one table for every edge between records (plans/029 §5.1).
 * These are the relationship rules the model validation fixtures established
 * (plans/data-model-validation/relationship-semantics.sh), run against the
 * stores instead of a prototype: direct task links beat newer inherited
 * session links, references bring no pull requests, a dismissal survives
 * branch discovery, outputs follow their session, a work's origin stays in the
 * access union, one task works on a session at a time, watches guard their
 * generation, and every delete leaves no dangling edge.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

const PERSON = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }
const OTHER_PERSON = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-2' }, displayName: 'Other' } }
const SYSTEM = { kind: 'system' as const }
const REPO = 'github.com/x/r'
const url = (number: number, repo = 'x/r') => `https://github.com/${repo}/pull/${number}`
/** A pull request as the stores read it. SAFETY: they read only these fields. */
const observed = (state: 'open' | 'merged' | 'closed', title = 'PR') => ({ title, state, draft: false, updatedAt: '2026-10-01T10:00:00Z' }) as never

let dataDir: string
let db: typeof import('@solus/server/db')
let database: typeof import('@solus/server/db/database')
let sessionPrs: typeof import('@solus/server/data/sessions/session-pull-requests')
let watches: typeof import('@solus/server/data/sessions/pull-request-watches')
let sessionLinks: typeof import('@solus/server/data/sessions/session-links')
let sessionRecords: typeof import('@solus/server/data/sessions/session-records')
let sessionArtifacts: typeof import('@solus/server/data/sessions/session-artifacts')
let sessionAccess: typeof import('@solus/server/data/works/session-access')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')
let taskLinks: typeof import('@solus/server/data/tasks/task-links')
let taskSessions: typeof import('@solus/server/data/tasks/task-sessions')
let works: typeof import('@solus/server/data/works/works')
let work: typeof import('@solus/server/data/works/work')
let links: typeof import('@solus/server/data/links/resource-links')
let rules: typeof import('@solus/server/prs/pr-watch-rules')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-resource-links-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  database = await import('@solus/server/db/database')
  sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
  watches = await import('@solus/server/data/sessions/pull-request-watches')
  sessionLinks = await import('@solus/server/data/sessions/session-links')
  sessionRecords = await import('@solus/server/data/sessions/session-records')
  sessionArtifacts = await import('@solus/server/data/sessions/session-artifacts')
  sessionAccess = await import('@solus/server/data/works/session-access')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  taskLinks = await import('@solus/server/data/tasks/task-links')
  taskSessions = await import('@solus/server/data/tasks/task-sessions')
  works = await import('@solus/server/data/works/works')
  work = await import('@solus/server/data/works/work')
  links = await import('@solus/server/data/links/resource-links')
  rules = await import('@solus/server/prs/pr-watch-rules')
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

const edgeRow = z.object({
  source_kind: z.string(), source_id: z.string(), target_kind: z.string(), target_scope: z.string(), target_key: z.string(),
  relation: z.string(), status: z.string(), source: z.string(), title: z.string(), pinned: z.number(), via_session_id: z.string().nullable(),
  repository: z.string().nullable(), number: z.number().nullable(), authority_key: z.string().nullable(), keeps_session: z.number(),
  watch_id: z.string().nullable(), watch_started_at: z.number().nullable(), watch_user_id: z.string().nullable(), watch_state: z.string().nullable(),
  created_by: z.string(), created_at: z.number(),
})
type EdgeRow = z.infer<typeof edgeRow>

async function edges(where = sql`1 = 1`): Promise<EdgeRow[]> {
  return edgeRow.array().parse(await database.getDatabase().all(sql`SELECT * FROM resource_links WHERE ${where} ORDER BY created_at, target_kind, target_scope, target_key`))
}

/** Sets an edge's time, so a test controls the order a reader sees. */
async function linkedAt(where: ReturnType<typeof sql>, at: number): Promise<void> {
  await database.getDatabase().run(sql`UPDATE resource_links SET created_at = ${at} WHERE ${where}`)
}

async function newTask(title: string): Promise<InstanceType<typeof tasks.Task>> {
  return tasks.Task.byId('local', (await taskStore.createTask('local', { title, projectKey: '/workspace/solus' })).id)
}

/** A task's pull requests as the sidebar reads them: `[scope, number, owner session]`, newest first. */
async function prList(taskId: string): Promise<Array<[string, number, string | null]>> {
  return ((await taskLinks.readTaskPrLinks(database.getDatabase(), 'local', [taskId]))[taskId] ?? [])
    .map((link) => [link.targetScope ?? '', link.number, link.ownerSessionId ?? null])
}

describe('a task and the pull requests of its sessions', () => {
  test('a direct link beats a newer inherited one, a reference brings none, and a dismissed one is not listed', async () => {
    // WHY (fixture 'PR result and order parity', 'direct beats newer inherited',
    // 'reference excluded', 'dismissed excluded'): the task page shows one row per
    // pull request; the task's own link is that row, however old, and a session the
    // task only mentions is not the task's work.
    const task = await newTask('Ship')
    await task.linkSession('s1', 'working')
    await task.linkSession('s2', 'working')
    await task.linkSession('sref', 'referenced')
    await sessionPrs.linkSessionPullRequest('s1', { url: url(1), title: 'inherited', source: 'manual', by: PERSON })
    await sessionPrs.linkSessionPullRequest('s2', { url: url(1), title: 'older duplicate', source: 'manual', by: PERSON })
    await sessionPrs.linkSessionPullRequest('s2', { url: url(2), title: 'second', source: 'manual', by: PERSON })
    await sessionPrs.linkSessionPullRequest('sref', { url: url(3), title: 'reference excluded', source: 'manual', by: PERSON })
    await sessionPrs.linkSessionPullRequest('s1', { url: url(4), title: 'dismissed', source: 'manual', by: PERSON })
    await sessionPrs.unlinkSessionPullRequest('s1', REPO, 4)
    await task.linkPullRequest({ number: 1, targetScope: REPO, url: url(1), title: 'direct wins even older' }, PERSON)
    await task.linkPullRequest({ number: 5, targetScope: REPO, url: url(5), title: 'direct second' }, PERSON)
    for (const [where, at] of [
      [sql`source_id = 's1' AND target_key = '1'`, 90], [sql`source_id = 's2' AND target_key = '1'`, 80], [sql`source_id = 's2' AND target_key = '2'`, 70],
      [sql`source_id = 'sref'`, 100], [sql`source_id = 's1' AND target_key = '4'`, 110],
      [sql`source_id = ${task.id} AND target_key = '1'`, 10], [sql`source_id = ${task.id} AND target_key = '5'`, 60],
    ] as const) await linkedAt(where, at)

    expect(await prList(task.id)).toEqual([[REPO, 2, 's2'], [REPO, 5, null], [REPO, 1, null]])
    const list = (await taskLinks.readTaskPrLinks(database.getDatabase(), 'local', [task.id]))[task.id]!
    expect(list.at(-1)?.title).toBe('direct wins even older')
    expect(list.some((link) => link.number === 3)).toBe(false)
    expect(list.some((link) => link.number === 4)).toBe(false)
  })

  test('a branch discovery cannot revive a dismissal; an explicit link can', async () => {
    const task = await newTask('Revive')
    await task.linkSession('s1', 'working')
    await sessionPrs.linkSessionPullRequest('s1', { url: url(4), source: 'manual', by: PERSON })
    await sessionPrs.unlinkSessionPullRequest('s1', REPO, 4)
    expect(await sessionPrs.linkSessionPullRequest('s1', { url: url(4), source: 'branch', by: SYSTEM })).toBe(false)
    expect(await prList(task.id)).toEqual([])
    expect(await sessionPrs.linkSessionPullRequest('s1', { url: url(4), source: 'manual', by: PERSON })).toBe(true)
    expect(await prList(task.id)).toEqual([[REPO, 4, 's1']])
    expect((await edges(sql`target_key = '4'`))[0]).toMatchObject({ status: 'active', keeps_session: 1 })
  })

  test('direct ties sort by key text, inherited ties by number, as the task page always did', async () => {
    // WHY (fixture 'negative control' and 'corrected direct tie order parity'):
    // the first proposal sorted every tie numerically and changed the page.
    const task = await newTask('Ties')
    await task.linkPullRequest({ number: 2, targetScope: 'github.com/ties/r', url: url(2, 'ties/r'), title: 'two' }, PERSON)
    await task.linkPullRequest({ number: 10, targetScope: 'github.com/ties/r', url: url(10, 'ties/r'), title: 'ten' }, PERSON)
    await task.linkSession('tie-session', 'working')
    await sessionPrs.linkSessionPullRequest('tie-session', { url: url(2, 'ties/other'), source: 'manual', by: PERSON })
    await sessionPrs.linkSessionPullRequest('tie-session', { url: url(10, 'ties/other'), source: 'manual', by: PERSON })
    await linkedAt(sql`target_kind = 'pr'`, 12)
    expect(await prList(task.id)).toEqual([
      ['github.com/ties/r', 2, null], ['github.com/ties/r', 10, null],
      ['github.com/ties/other', 10, 'tie-session'], ['github.com/ties/other', 2, 'tie-session'],
    ])
  })

  test('an unresolved checkout path keeps its raw identity, and its resolution never merges another path', async () => {
    // WHY (fixture 'unresolved path identity retained', 'resolution attaches
    // qualified observation without merging another path', alias collision policy):
    // two raw aliases of one pull request are two edges until PR sync names the
    // repository, and a second alias that disagrees on its title stays unresolved.
    const task = await newTask('Aliases')
    await database.getDatabase().transaction(async (tx) => {
      await taskLinks.writeTaskLink(tx, 'local', task.id, { kind: 'pr', targetScope: '/checkout/one', targetKey: '9', title: 'unresolved one' }, PERSON)
      await taskLinks.writeTaskLink(tx, 'local', task.id, { kind: 'pr', targetScope: '/checkout/two', targetKey: '9', title: 'unresolved two' }, PERSON)
    })
    expect((await edges(sql`target_key = '9'`)).map((edge) => edge.repository)).toEqual([null, null])
    expect(await database.getDatabase().all(sql`SELECT 1 FROM pull_request_observations`)).toEqual([])

    await taskLinks.recordPullRequestObservation('github.com/resolved/r', ['/checkout/one', '/checkout/two'], 9, observed('closed', 'resolved'))
    const resolved = await edges(sql`target_key = '9'`)
    expect(resolved).toHaveLength(2)
    expect(resolved.map((edge) => [edge.target_scope, edge.repository])).toEqual([['/checkout/one', 'github.com/resolved/r'], ['/checkout/two', null]])
    // Both rows stay the task's; the page dedupes them by canonical key only once both resolve.
    expect((await prList(task.id)).map(([scope]) => scope).sort()).toEqual(['/checkout/one', '/checkout/two'])
  })
})

describe('outputs follow their session', () => {
  test('a removed output stays removed; a claimed output survives the session leaving; an unclaimed one leaves', async () => {
    // WHY (fixture 'removed output stays removed on repeated binding', 'claimed
    // output remains; unclaimed leaves', 'PR parity after session departure').
    const task = await newTask('Outputs')
    await task.linkSession('s1', 'working')
    for (const key of ['remove', 'claim', 'follow']) {
      await tasks.Task.linkSessionOutput('local', 's1', { kind: 'work', targetKey: key, title: key })
    }
    await task.unlink('work', 'remove', '', PERSON)
    // Rebinding an existing session is bookkeeping: nothing is adopted again.
    await task.linkSession('s1', 'working')
    expect((await edges(sql`target_kind = 'work'`)).map((edge) => edge.target_key).sort()).toEqual(['claim', 'follow'])
    // A deliberate link of an output makes it the task's own.
    await task.link({ kind: 'work', targetKey: 'claim' }, PERSON)
    expect((await edges(sql`target_key = 'claim'`))[0]).toMatchObject({ relation: 'reference', via_session_id: null })
    await sessionPrs.linkSessionPullRequest('s1', { url: url(1), source: 'manual', by: PERSON })

    await task.unlinkSession('s1', PERSON)
    expect((await edges(sql`target_kind = 'work'`)).map((edge) => edge.target_key)).toEqual(['claim'])
    expect(await prList(task.id)).toEqual([])
  })
})

describe('a work and its sessions', () => {
  test('unlinking the origin hides the work from its artifacts, and the origin stays in the access union', async () => {
    // WHY (fixture 'origin unlink hides artifact membership', 'origin remains in
    // access union'): membership is the visible edge; `works.session_id` is who may open it.
    const made = await works.createWork('local', 'Made here', 'doc', '', '', 'origin', 'codex')
    await sessionLinks.linkSessionItem('other', { target: { kind: 'work', targetId: made.id } }, SYSTEM)
    expect((await works.loadWork('local', made.id))?.sessionIds).toEqual(['origin', 'other'])
    await (await work.Work.find('local', made.id))!.unlinkSession('origin')

    expect((await works.loadWork('local', made.id))?.sessionIds).toEqual(['other'])
    expect((await sessionArtifacts.readOwnSessionArtifacts('local', 'origin')).some((item) => item.kind === 'work')).toBe(false)
    expect((await sessionArtifacts.readOwnSessionArtifacts('local', 'other')).some((item) => item.kind === 'work' && item.workId === made.id)).toBe(true)
    expect((await sessionAccess.sessionIdsOfWorks(database.getDatabase(), [made.id])).get(made.id)?.sort()).toEqual(['origin', 'other'])
  })

  test('a membership edge is the session owner\'s when nobody is named, and the person\'s when one is', async () => {
    const made = await works.createWork('local', 'Doc', 'doc', '', '', undefined, 'codex')
    await database.getDatabase().run(sql`INSERT INTO session_records(session_id, organization_id, created_by, created_at) VALUES ('owned', 'local', 'owner-key', 1)`)
    await (await work.Work.find('local', made.id))!.linkSession('owned')
    await sessionLinks.linkSessionItem('other', { target: { kind: 'work', targetId: made.id } }, PERSON)
    expect((await edges(sql`target_kind = 'work'`)).map((edge) => [edge.source_id, edge.created_by])).toEqual([['owned', 'owner-key'], ['other', 'user-1']])
  })
})

describe('one task works on a session at a time', () => {
  test('a working link elsewhere transfers ownership; a reference claims nothing; a moved task keeps history', async () => {
    // WHY (fixture 'one active working owner', 'reference does not claim
    // ownership', 'historical owner permits transfer').
    const first = await newTask('First')
    const second = await newTask('Second')
    await first.linkSession('s2', 'working')
    await second.linkSession('s2', 'referenced')
    expect((await edges(sql`target_key = 's2'`)).map((edge) => [edge.source_id, edge.relation])).toEqual([[first.id, 'works-on'], [second.id, 'reference']])
    // The index holds what the command keeps: a second active owner cannot be written.
    await expect(database.getDatabase().run(sql`
      INSERT INTO resource_links(organization_id, source_kind, source_id, target_kind, target_scope, target_key, relation, source, status, created_by, created_at)
      VALUES ('local', 'task', 'different', 'session', '', 's2', 'works-on', 'system', 'active', 'x', 1)`)).rejects.toThrow()

    // The first task moved to its organization: its edge is history, no longer the owner.
    await first.moveTo({ organizationId: 'org-1' })
    await second.linkSession('s2', 'working')
    expect((await edges(sql`target_key = 's2'`)).map((edge) => [edge.source_id, edge.relation, edge.status]))
      .toEqual([[first.id, 'works-on', 'historical'], [second.id, 'works-on', 'active']])
    expect(await taskSessions.taskIdForSession('local', 's2')).toBe(second.id)
  })
})

describe('watches live on the link', () => {
  test('a watch needs a live link; a restart replaces the generation; a stale generation writes nothing', async () => {
    // WHY (fixture 'stale watch update rejected', 'watch restart keeps new actor',
    // 'current watch update accepted', 'stale watch end rejected', 'watch cannot be
    // stored on task'): a read that finishes after a stop or a restart must not
    // write over the new watch.
    await expect(watches.startPullRequestWatch('s2', REPO, 2, rules.initialWatchState(1), 'person-a', 1)).rejects.toThrow('links')
    await sessionPrs.linkSessionPullRequest('s2', { url: url(2), source: 'manual', by: PERSON })
    const first = await watches.startPullRequestWatch('s2', REPO, 2, rules.initialWatchState(1), 'person-a', 1)
    const second = await watches.startPullRequestWatch('s2', REPO, 2, rules.initialWatchState(2), 'person-b', 2)
    expect(await watches.recordPullRequestWatchState(first, { ...first.state, conflicting: true })).toBe(false)
    expect(await watches.recordPullRequestWatchState(second, { ...second.state, conflicting: true })).toBe(true)
    expect(await watches.readPullRequestWatches(['s2'])).toEqual([expect.objectContaining({ watchId: second.watchId, actingUserKey: 'person-b', state: expect.objectContaining({ conflicting: true }) })])
    expect(await watches.endPullRequestWatch(first)).toBe(false)
    expect((await sessionPrs.readSessionPullRequests('local', ['s2']))['s2']?.[0]?.watch).toEqual({ startedAt: 2 })
    expect(await watches.endPullRequestWatch(second)).toBe(true)
    expect(await watches.readPullRequestWatches()).toEqual([])
  })

  test('a dismissal clears the watch in the same write, and a dismissed link keeps no session listed', async () => {
    // WHY (fixture 'cannot dismiss without clearing watch', 'dismissal clears all
    // watch columns', 'dismissed edge no longer a candidate').
    await sessionPrs.linkSessionPullRequest('s2', { url: url(2), source: 'manual', by: PERSON })
    await watches.startPullRequestWatch('s2', REPO, 2, rules.initialWatchState(1), 'person-a', 1)
    const heard: string[] = []
    const stop = watches.onPullRequestWatchesChanged((sessionId) => heard.push(sessionId))
    try {
      expect(await sessionPrs.unlinkSessionPullRequest('s2', REPO, 2)).toBe(true)
    } finally {
      stop()
    }
    expect(heard).toEqual(['s2'])
    expect((await edges(sql`target_key = '2'`))[0]).toMatchObject({ status: 'dismissed', keeps_session: 0, watch_id: null, watch_started_at: null, watch_user_id: null, watch_state: null })
  })

  test('a branch discovery that replaces an ended branch link takes its watch with it', async () => {
    await sessionPrs.linkSessionPullRequest('s1', { url: url(7), source: 'branch', by: SYSTEM })
    await watches.startPullRequestWatch('s1', REPO, 7, rules.initialWatchState(1), null, 1)
    await sessionPrs.recordSessionPullRequestObservation(REPO, 7, observed('merged'))
    expect(await sessionPrs.linkSessionPullRequest('s1', { url: url(8), source: 'branch', by: SYSTEM })).toBe(true)
    expect((await edges(sql`source_id = 's1'`)).map((edge) => edge.number)).toEqual([8])
    expect(await watches.readPullRequestWatches()).toEqual([])
  })
})

describe('who made an edge', () => {
  test('created_by is the person acting, else the owner of the record the edge starts from', async () => {
    // WHY (plans/029 decision 2): `created_by` is a user id set from the acting
    // identity, never a client value; an agent or Solus itself records the owner.
    await database.getDatabase().run(sql`INSERT INTO session_records(session_id, organization_id, created_by, created_at) VALUES ('owned', 'local', 'owner-key', 1)`)
    await sessionPrs.linkSessionPullRequest('owned', { url: url(1), source: 'branch', by: SYSTEM })
    await sessionPrs.linkSessionPullRequest('owned', { url: url(2), source: 'manual', by: OTHER_PERSON })
    await sessionLinks.linkSessionItem('owned', { target: { kind: 'file', path: '/tmp/a.md', hostId: 'host-1' } }, { kind: 'agent', sessionId: 'owned', for: PERSON.user })
    const task = await newTask('Creators')
    await task.linkSession('owned', 'working')
    await task.link({ kind: 'automation', targetKey: 'auto-1', title: 'Nightly', automatic: true }, SYSTEM)
    // The task's owner is the host's user, as `createTask` records it when nobody is named.
    const { hostUserKey } = await import('@solus/server/host/host-user')
    expect(Object.fromEntries((await edges()).map((edge) => [`${edge.source_kind}→${edge.target_kind}:${edge.target_key}`, [edge.created_by, edge.source]]))).toEqual({
      'session→pr:1': ['owner-key', 'branch'],
      'session→pr:2': ['user-2', 'manual'],
      'session→file:/tmp/a.md': ['user-1', 'agent'],
      'task→session:owned': [hostUserKey(), 'system'],
      'task→automation:auto-1': [hostUserKey(), 'system'],
    })
  })
})

describe('deletes leave no dangling edge', () => {
  test('a task, a work, and a session take their edges with them', async () => {
    const task = await newTask('Gone')
    const made = await works.createWork('local', 'Made', 'doc', '', '', 's1', 'codex')
    await task.linkSession('s1', 'working')
    await task.link({ kind: 'work', targetKey: made.id }, PERSON)
    await task.link({ kind: 'plan', targetScope: 's1', targetKey: 'plan-1', title: 'Plan' }, PERSON)
    await sessionPrs.linkSessionPullRequest('s1', { url: url(1), source: 'manual', by: PERSON })
    await sessionLinks.linkSessionItem('s1', { target: { kind: 'file', path: '/tmp/a.md', hostId: 'host-1' } }, PERSON)
    expect(await links.danglingEdgeCount(database.getDatabase())).toBe(0)
    expect(await edges()).toHaveLength(6)

    await (await work.Work.find('local', made.id))!.delete()
    expect((await edges()).some((edge) => edge.target_kind === 'work')).toBe(false)
    expect(await links.danglingEdgeCount(database.getDatabase())).toBe(0)
    await task.delete()
    expect((await edges()).some((edge) => edge.source_kind === 'task')).toBe(false)
    expect(await links.danglingEdgeCount(database.getDatabase())).toBe(0)
    await sessionRecords.deleteSessionRecord('local', 's1')
    expect(await edges()).toEqual([])
    expect(await links.danglingEdgeCount(database.getDatabase())).toBe(0)
  })
})
