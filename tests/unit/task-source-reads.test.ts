import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { DatabaseSync } from './helpers/bun-sqlite'
import { taskSourceKey } from '@solus/contracts/task-sources'
import { BOARD, boardRead, githubIssue, REPO, repoRead } from './helpers/task-fixtures'
import { openTaskTestHost } from './helpers/task-test-host'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: the host's copy of tasks is shared by everyone on the host, and a
// provider has rate limits. So the host owns freshness: it reads a source one
// time for many projects and callers, and a person sees the tasks of a source
// only after their own provider connection read it.

const ALICE = 'user:alice'
const BOB = 'user:bob'
const REPO_KEY = taskSourceKey(REPO)

let host: Awaited<ReturnType<typeof openTaskTestHost>>
let sources: typeof import('@solus/server/data/tasks/task-sources')
let store: typeof import('@solus/server/data/tasks/task-store')
let sidebar: typeof import('@solus/server/data/tasks/task-sidebar')
let attachments: typeof import('@solus/server/data/tasks/task-attachments')
let cache: typeof import('@solus/server/data/tasks/task-cache')
let assignment: typeof import('@solus/server/data/tasks/task-assignment')
let tasks: typeof import('@solus/server/data/tasks/task')
let database: typeof import('@solus/server/db/database')

beforeAll(async () => {
  host = await openTaskTestHost('task-source-reads')
  sources = await import('@solus/server/data/tasks/task-sources')
  store = await import('@solus/server/data/tasks/task-store')
  sidebar = await import('@solus/server/data/tasks/task-sidebar')
  attachments = await import('@solus/server/data/tasks/task-attachments')
  cache = await import('@solus/server/data/tasks/task-cache')
  assignment = await import('@solus/server/data/tasks/task-assignment')
  tasks = await import('@solus/server/data/tasks/task')
  database = await import('@solus/server/db/database')
})
afterEach(() => host.reset())
afterAll(() => host.close())

/** How long a copy that nothing holds stays after the last provider answer. */
const unheldMaxAge = () => store.UNHELD_TASK_MAX_AGE_MS

/** The titles a person sees in the task list. */
async function titlesFor(personKey: string): Promise<string[]> {
  return (await store.listTasks({ personKey, scope: 'local' })).map((task) => task.title).sort()
}

/** Ask for a project's sources as a person, and wait for the reads that the call started. */
async function ask(cwd: string, personKey: string, options: { refresh?: 'stale' | 'force'; now?: number } = {}) {
  const answer = await sources.tasksSources([cwd], personKey, options)
  await sources.taskSourceReadsEnd()
  return answer[cwd]
}

describe('reading task sources', () => {
  test('the first call answers at once with a source that is refreshing, and the read fills it', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1), githubIssue(2, { state: { name: 'Closed', category: 'done' } })]))
    const cwd = host.project([REPO])
    const changed: string[][] = []
    const stop = sources.onTaskSourcesChanged((sourceKeys) => changed.push(sourceKeys))

    const first = (await sources.tasksSources([cwd], ALICE))[cwd]
    await sources.taskSourceReadsEnd()
    // Never read for Alice: no columns, no time of a read, and the read is in flight.
    expect(first.sources).toEqual([{ sourceKey: REPO_KEY, source: REPO, label: 'acme/app', columns: [], health: 'ok', refreshing: true }])
    expect(first.defaultSourceKey).toBe(REPO_KEY)

    stop()
    expect(changed).toEqual([[REPO_KEY]])
    const after = (await sources.tasksSources([cwd], ALICE))[cwd].sources[0]
    expect(after.columns.map((column) => column.name)).toEqual(['Open', 'Closed'])
    expect(after.fetchedAt).toBeGreaterThan(0)
    expect(after.refreshing).toBeUndefined()
    expect(await titlesFor(ALICE)).toEqual(['Issue 1', 'Issue 2'])
    // Each task carries where its source puts it, and the category that follows.
    const tasks = await store.listTasks({ personKey: ALICE, scope: 'local' })
    expect(tasks.find((task) => task.title === 'Issue 2')).toMatchObject({
      category: 'done', placements: [{ sourceKey: REPO_KEY, columnId: 'closed' }], reference: 'acme/app#2',
    })
  })

  test('a fresh source is not read again, a stale one is, and force always reads', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    const cwd = host.project([REPO])
    const start = Date.now()
    await ask(cwd, ALICE, { now: start })
    expect(host.providers.callsOf('read:')).toHaveLength(1)

    // Within 30 s: a second panel, a reconnect, another project with the same source.
    await ask(cwd, ALICE, { now: start + sources.SOURCE_FRESH_MS - 1_000 })
    await ask(host.project([REPO]), ALICE, { now: start + sources.SOURCE_FRESH_MS - 1_000 })
    expect(host.providers.callsOf('read:')).toHaveLength(1)

    const later = Date.now() + sources.SOURCE_FRESH_MS + 1
    await ask(cwd, ALICE, { now: later })
    expect(host.providers.callsOf('read:')).toHaveLength(2)

    // Fresh again, but the person pressed Refresh.
    await ask(cwd, ALICE, { refresh: 'force', now: later + 1 })
    expect(host.providers.callsOf('read:')).toHaveLength(3)
  })

  test('two callers during one read cause one provider read', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    let open!: () => void
    host.providers.readGate = new Promise((resolve) => { open = resolve })
    const cwd = host.project([REPO])
    const otherProject = host.project([REPO, BOARD])
    host.providers.answer(BOARD, boardRead([]))

    await sources.tasksSources([cwd], ALICE, { refresh: 'force' })
    await sources.tasksSources([cwd, otherProject], ALICE, { refresh: 'force' })
    open()
    await sources.taskSourceReadsEnd()
    expect(host.providers.callsOf(`read:${REPO_KEY}`)).toHaveLength(1)
  })

  test('a person sees the tasks of a source only after their own connection read it', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    const cwd = host.project([REPO])
    await ask(cwd, ALICE)
    expect(await titlesFor(ALICE)).toEqual(['Issue 1'])
    // The copy is on the host, but Bob's connection never read the source.
    expect(await titlesFor(BOB)).toEqual([])

    // Bob's GitHub account cannot read the repository.
    host.providers.failure = Object.assign(new Error('Not Found'), { status: 404 })
    await ask(cwd, BOB)
    host.providers.failure = null
    const refused = (await sources.tasksSources([cwd], BOB))[cwd].sources[0]
    expect(refused).toMatchObject({ health: 'no_access', columns: [] })
    expect(refused.fetchedAt).toBeUndefined()
    expect(await titlesFor(BOB)).toEqual([])
    // Bob's refusal says nothing about Alice's connection.
    expect((await sources.tasksSources([cwd], ALICE))[cwd].sources[0].health).toBe('ok')
    expect(await titlesFor(ALICE)).toEqual(['Issue 1'])
  })

  test('a person with no access who asks during another read gets their own read after it', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    let open!: () => void
    host.providers.readGate = new Promise((resolve) => { open = resolve })
    const cwd = host.project([REPO])
    await sources.tasksSources([cwd], ALICE)
    await sources.tasksSources([cwd], BOB)
    host.providers.readGate = null
    open()
    // Alice's read gave Bob nothing: only his own connection gives him access.
    await sources.taskSourceReadsEnd()
    expect(host.providers.callsOf('read:')).toHaveLength(2)
    expect(await titlesFor(BOB)).toEqual(['Issue 1'])
  })

  test('a failed read keeps the tasks the host had, and says why', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    const cwd = host.project([REPO])
    await ask(cwd, ALICE)

    host.providers.failure = new Error('GitHub is not connected')
    await ask(cwd, ALICE, { refresh: 'force' })
    const failed = (await sources.tasksSources([cwd], ALICE))[cwd].sources[0]
    expect(failed).toMatchObject({ health: 'not_connected', message: 'Connect GitHub to read these tasks.' })
    // Offline, or signed out: the last copy still shows, with its columns.
    expect(failed.columns).toHaveLength(2)
    expect(await titlesFor(ALICE)).toEqual(['Issue 1'])
  })

  test('a task that leaves a source leaves the list, and the read names what changed', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1), githubIssue(2)]))
    const cwd = host.project([REPO])
    await ask(cwd, ALICE)
    const named: Array<string | undefined> = []
    const stop = store.onTasksChanged((taskId) => named.push(taskId))

    host.providers.answer(REPO, repoRead([githubIssue(1, { title: 'Renamed', updatedAt: 3_000 })]))
    await ask(cwd, ALICE, { refresh: 'force' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    stop()
    expect(await titlesFor(ALICE)).toEqual(['Renamed'])
    // The renamed task and the task that left: a client reads those two rows, not the list.
    expect(named.sort()).toEqual(['github:I_1', 'github:I_2'])
  })

  test('a truncated source says so', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)], true))
    const cwd = host.project([REPO])
    await ask(cwd, ALICE)
    expect((await sources.tasksSources([cwd], ALICE))[cwd].sources[0].truncated).toBe(true)
  })

  test('a project with no task source has none, and no default', async () => {
    const cwd = host.project([])
    expect((await sources.tasksSources([cwd], ALICE))[cwd]).toEqual({ sources: [] })
    expect(host.providers.calls).toEqual([])
  })

  test('the timer reads a wanted source again, and forgets a source nobody asked for in 15 minutes', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    const cwd = host.project([REPO])
    const start = Date.now()
    await ask(cwd, ALICE, { now: start })

    await sources.readWantedTaskSources(start + sources.SOURCE_POLL_MS)
    expect(host.providers.callsOf('read:')).toHaveLength(2)

    await sources.readWantedTaskSources(start + sources.SOURCE_WANTED_MS + 1)
    expect(host.providers.callsOf('read:')).toHaveLength(2)
  })
})

describe('the task list of one reader', () => {
  test('a task that a session of the reader is linked to shows, also when the reader never read its source', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1), githubIssue(2)]))
    await ask(host.project([REPO]), ALICE)
    // Bob has no GitHub access, but a session in his organization works on issue 2.
    await attachments.linkTaskSession('local', 'github:I_2', 'session-1')

    const bob = await sidebar.readTaskSidebarSnapshot({ personKey: BOB, scope: 'local' })
    expect(bob.tasks.map((task) => task.id)).toEqual(['github:I_2'])
    // He did not read the source, so he does not see where it puts the task.
    expect(bob.tasks[0].placements).toEqual([])
    expect(bob.sessionsByTask['github:I_2'].map((link) => link.sessionId)).toEqual(['session-1'])

    // A reader of another organization does not see the link, and so not the task.
    const other = await sidebar.readTaskSidebarSnapshot({ personKey: BOB, scope: 'org-2' })
    expect(other.tasks).toEqual([])
    expect(other.sessionsByTask).toEqual({})
  })

  test('the links of a task key that the host never read are in the snapshot', async () => {
    // WHY: the organization's Solus API holds attachments and no task copies.
    await attachments.linkTaskSession('local', 'jira:site:10042', 'session-9')
    const snapshot = await sidebar.readTaskSidebarSnapshot({ personKey: ALICE, scope: 'local' })
    expect(snapshot.tasks).toEqual([])
    expect(snapshot.sessionsByTask['jira:site:10042'].map((link) => link.sessionId)).toEqual(['session-9'])
  })
})

describe('a task that leaves its source', () => {
  test('its copy is deleted when nothing holds it, and kept while a session, a link or an unsent comment holds it', async () => {
    // WHY: the copy is a cache. A closed-and-forgotten issue must not stay on
    // the host for ever, but what Solus attached to a task must still find it.
    host.providers.answer(REPO, repoRead([githubIssue(1), githubIssue(2), githubIssue(3), githubIssue(4)]))
    const cwd = host.project([REPO])
    await ask(cwd, ALICE)
    await attachments.linkTaskSession('local', 'github:I_2', 'session-1')
    await attachments.linkTask('local', 'github:I_3', { kind: 'automation', targetKey: 'auto-1', title: 'Nightly' }, { kind: 'system' })
    host.providers.failure = new Error('socket hang up')
    await tasks.commentOnTask('local', 'github:I_4', { body: 'Not sent yet', by: { kind: 'system' } })
    host.providers.failure = null

    host.providers.answer(REPO, repoRead([]))
    await ask(cwd, ALICE, { refresh: 'force' })
    expect(await store.loadTask('github:I_1')).toBeNull()
    expect((await store.loadTask('github:I_2'))?.placements).toEqual([])
    expect(await store.loadTask('github:I_3')).not.toBeNull()
    expect((await tasks.taskDetails('local', 'github:I_4')).comments).toMatchObject([{ body: 'Not sent yet', unsent: true }])
  })
})

describe('a task that only a search found', () => {
  test('its copy is deleted one day after the last provider answer, when nothing holds it', async () => {
    // WHY: a search past the cap of a source makes a copy that no source read
    // replaces. Without an age limit each search would leave rows for ever.
    const day = unheldMaxAge()
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    host.providers.hold(githubIssue(50, { title: 'Old flaky spec' }), githubIssue(51, { title: 'Old flaky test' }), githubIssue(52, { title: 'Old flaky run' }))
    const cwd = host.project([REPO])
    await ask(cwd, ALICE)
    expect((await tasks.searchTasks(cwd, 'old flaky')).map((task) => task.id).sort()).toEqual(['github:I_50', 'github:I_51', 'github:I_52'])
    await attachments.linkTaskSession('local', 'github:I_51', 'session-1')

    // A read on the same day keeps the copies: the person may still open one.
    await cache.storeSourceRead(REPO, repoRead([githubIssue(1)]), Date.now() + day - 60_000)
    expect(await store.loadTask('github:I_50')).not.toBeNull()

    // Issue 52 was read again later, so it is not old.
    await cache.storeProviderTask(githubIssue(52, { title: 'Old flaky run' }))
    const laterRead = Date.now() + day + 60_000
    await database.getDatabase().run(sql`UPDATE tasks SET fetched_at = ${laterRead - 1_000} WHERE id = 'github:I_52'`)
    await cache.storeSourceRead(REPO, repoRead([githubIssue(1)]), laterRead)
    expect(await store.loadTask('github:I_50')).toBeNull()
    // A session holds issue 51, and issue 1 is in its source.
    expect(await store.loadTask('github:I_51')).not.toBeNull()
    expect(await store.loadTask('github:I_52')).not.toBeNull()
    expect(await store.loadTask('github:I_1')).not.toBeNull()
  })
})

describe('a task that became yours', () => {
  /** The notifications a person has, as `[kind, resource]`. */
  async function notificationsOf(personKey: string): Promise<Array<[string, string]>> {
    const rows = await database.getDatabase().all(sql`SELECT kind, resource_key FROM notifications WHERE user_id = ${personKey} ORDER BY created_at`)
    // SAFETY: the statement selects these two text columns.
    return (rows as Array<{ kind: string; resource_key: string }>).map((row) => [row.kind, row.resource_key])
  }

  test('a source read names each task whose assignee changed, and the first read of a task names none', async () => {
    // The first read is a baseline: a task that was mine before Solus saw it is not news.
    const first = await cache.storeSourceRead(REPO, repoRead([githubIssue(1, { assignee: 'octocat' }), githubIssue(2)]))
    expect(first.assigned).toEqual([])
    const second = await cache.storeSourceRead(REPO, repoRead([
      githubIssue(1, { assignee: 'octocat' }),
      githubIssue(2, { assignee: 'octocat', updatedAt: 7_000 }),
      githubIssue(3, { assignee: 'octocat' }),
    ]))
    expect(second.assigned).toEqual([{ taskId: 'github:I_2', title: 'Issue 2', provider: 'github', assignee: 'octocat', updatedAt: 7_000 }])
  })

  test('the person whose own login it is is told one time; another person, and a Jira display name, are not', async () => {
    const mine = { taskId: 'github:I_2', title: 'Issue 2', provider: 'github' as const, assignee: 'Octocat', updatedAt: 7_000 }
    const jira = { taskId: 'jira:site:10001', title: 'Jira 1', provider: 'jira' as const, assignee: 'octocat', updatedAt: 7_000 }
    await assignment.notifyTaskAssignments([mine, jira], ALICE, async () => 'octocat')
    // The same change seen by a second read (a detail read after the source read) is the same event.
    await assignment.notifyTaskAssignments([mine], ALICE, async () => 'octocat')
    await assignment.notifyTaskAssignments([mine], BOB, async () => 'hubot')
    // A connection with no stored login (`gh`) cannot say "this is you".
    await assignment.notifyTaskAssignments([mine], BOB, async () => null)
    expect(await notificationsOf(ALICE)).toEqual([['task.assigned', 'task:github:I_2']])
    expect(await notificationsOf(BOB)).toEqual([])
  })

  test('the notifications of a deleted draft go with it', async () => {
    const { githubDraft, BOARD, boardRead } = await import('./helpers/task-fixtures')
    host.providers.answer(BOARD, boardRead([{ task: githubDraft('DI_1'), columnId: null }]))
    const cwd = host.project([BOARD])
    await sources.tasksSources([cwd], ALICE)
    await sources.taskSourceReadsEnd()
    await assignment.notifyTaskAssignments([{ taskId: 'github:DI_1', title: 'Draft', provider: 'github', assignee: 'octocat', updatedAt: 1 }], ALICE, async () => 'octocat')
    expect(await notificationsOf(ALICE)).toHaveLength(1)
    await tasks.deleteTask('github:DI_1')
    expect(await notificationsOf(ALICE)).toEqual([])
  })
})
