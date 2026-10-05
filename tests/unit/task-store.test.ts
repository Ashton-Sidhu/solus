import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'

/** Solus itself, as the doer of what it found or did on its own. */
const SYSTEM_ATTRIBUTION = { kind: 'system' as const }
/** The person every change in this file is made by. */
const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }
/** An agent's session, as the doer of what it wrote. */
const AGENT = { kind: 'agent' as const, sessionId: 'agent-session' }

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/data/tasks/task-store')
type TaskModule = typeof import('@solus/server/data/tasks/task')
type TaskSessionsModule = typeof import('@solus/server/data/tasks/task-sessions')
type TaskLinksModule = typeof import('@solus/server/data/tasks/task-links')
type UlidModule = typeof import('@solus/contracts/ulid')

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let taskSessions: TaskSessionsModule
let taskLinks: TaskLinksModule
let ids: UlidModule
let migrationsFolder: typeof import('@solus/server/db/migration-files').migrationsFolder
let testHandlerCtx: import('@solus/server/transport/server').HandlerCtx
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-store-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  taskSessions = await import('@solus/server/data/tasks/task-sessions')
  taskLinks = await import('@solus/server/data/tasks/task-links')
  ids = await import('@solus/contracts/ulid')
  ;({ migrationsFolder } = await import('@solus/server/db/migration-files'))
  testHandlerCtx = (await import('./helpers/handler-ctx')).TEST_HANDLER_CTX
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

/** A task with one session on it, as a session that joined the task has. */
async function taskWithSession(sessionId: string, title: string) {
  const task = await taskStore.createTask('local', { title, projectKey: '/workspace/solus' })
  return taskSessions.prepareSessionTask('local', { taskId: task.id, sessionId, projectKey: '/workspace/solus' })
}

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('native task migration', () => {
  test('ULIDs preserve timestamp ordering in their canonical text form', () => {
    expect(ids.ulid(10)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(ids.ulid(10) < ids.ulid(11)).toBe(true)
    expect(() => ids.ulid(-1)).toThrow('ULID timestamp')
  })

  // The file is the store only on SQLite; on Postgres these tables are not in it.
  test.skipIf(process.env.SOLUS_DB === 'postgres')('a new file is made from the baselines; a file from before them is refused, not half-read', async () => {
    // WHY: the schema was reset to one baseline per engine. A file an older
    // build made has none of the steps between, so opening it must stop with
    // a message that names the fix instead of running queries on a wrong shape.
    const fresh = db.getDb()
    const tables = () => db.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%task%' OR name = 'asset_publications' ORDER BY name",
    ).all().map((row) => (row as { name: string }).name)
    expect(tables()).toEqual([
      'asset_publications', 'task_comments', 'task_counters', 'task_external_links',
      'task_links', 'task_session_links', 'tasks', 'upstream_task_cache',
    ])
    const generated = readdirSync(migrationsFolder('sqlite')).filter((file) => file.endsWith('.sql')).length
    expect(fresh.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: generated })
    db.closeDb()
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })

    const legacy = new Database(join(dataDir, 'solus.db'))
    legacy.exec('PRAGMA user_version = 50')
    legacy.close()
    expect(() => db.getDb()).toThrow('predates the current schema')
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  })
})

describe('organization scoping', () => {
  test('a task created for one organization is invisible to another', async () => {
    // WHY: in the cloud one database serves every organization. A read that
    // forgot its organization would list one team's work to another; the scope
    // is on every read, so a foreign id is simply not found.
    const ours = await taskStore.createTask('org-a', { title: 'Ours', projectKey: '/workspace/solus' })
    await taskStore.createTask('org-b', { title: 'Theirs', projectKey: '/workspace/solus' })

    expect((await taskStore.listTasks('org-a')).tasks.map((task) => task.title)).toEqual(['Ours'])
    expect((await taskStore.listTasks('org-b')).tasks.map((task) => task.title)).toEqual(['Theirs'])
    expect((await taskStore.listTasks('local')).tasks).toEqual([])
    await expect(tasks.Task.byId('org-b', ours.id)).rejects.toThrow('not found')
    expect(await taskStore.loadTaskRecord('org-b', ours.id)).toBeNull()

    await (await tasks.Task.byId('org-a', ours.id)).linkSession('shared-session-id', 'working')
    expect(await taskSessions.tasksForSession('org-b', 'shared-session-id')).toBeNull()
    expect(await tasks.Task.forSession('org-b', 'shared-session-id')).toBeNull()
    expect((await taskSessions.tasksForSession('org-a', 'shared-session-id'))?.task.id).toBe(ours.id)
    expect((await taskSessions.taskSessions('org-b'))[ours.id]).toBeUndefined()
    expect((await taskStore.listTasks('org-b')).tasks.map((task) => task.title)).toEqual(['Theirs'])
  })
})

describe('native task CRUD', () => {
  test('lists more than 99 tasks without truncation', async () => {
    // WHY: the global task picker consumes this complete native snapshot. A
    // hidden two-digit boundary would make older work impossible to search.
    const creations = Array.from({ length: 105 }, (_, index) =>
      taskStore.createTask('local', {
        title: `Searchable task ${index + 1}`,
        projectKey: '/workspace/solus',
      }),
    )
    await Promise.all(creations)

    expect((await taskStore.listTasks('local')).tasks).toHaveLength(105)
  })

  test('restores every scoped PR link for the sidebar after restart', async () => {
    // WHY: agent link calls can identify a PR by number without a URL.
    // The durable edge, not the renderer PR list, must restore the chip.
    const task = await taskStore.createTask('local', {
      title: 'Keep linked PR visible',
      projectKey: '/workspace/solus',
    })
    await (await tasks.Task.byId('local', task.id)).link({
      kind: 'pr',
      targetScope: '/workspace/solus',
      targetKey: '43',
      url: 'https://github.com/solus-sh/solus/pull/43',
      originSessionId: 'session-43',
    }, AGENT)
    await (await tasks.Task.byId('local', task.id)).link({
      kind: 'pr',
      targetScope: 'github.com/other/repo',
      targetKey: '43',
      title: '#43 other/repo',
      url: 'https://github.com/other/repo/pull/43',
    }, BY)

    expect(await taskLinks.readTaskPrLinks(taskStore.database(), 'local')).toEqual({
      [task.id]: [
        {
          number: 43,
          title: '#43 other/repo',
          targetScope: 'github.com/other/repo',
          url: 'https://github.com/other/repo/pull/43',
          createdBy: BY,
        },
        {
          number: 43,
          title: '#43',
          targetScope: 'github.com/solus-sh/solus',
          url: 'https://github.com/solus-sh/solus/pull/43',
          createdBy: AGENT,
          originSessionId: 'session-43',
        },
      ],
    })
  })

  test('lists a task linked to an unknown external provider without its ticket', async () => {
    // WHY: a link written by a newer build (or another branch) shares the same
    // data directory. One unrecognized provider must not fail the whole task
    // list; the task still lists, only its ticket is left out.
    const known = await taskStore.createTask('local', { title: 'Mirrored issue', projectKey: '/workspace/solus' })
    const unknown = await taskStore.createTask('local', { title: 'Foreign ticket', projectKey: '/workspace/solus' })
    const { taskExternalLinks } = await import('@solus/server/data/tasks/schema')
    for (const [taskId, provider, externalKey, externalId, url] of [
      [known.id, 'github', 'solus/solus', '7', 'https://github.com/solus/solus/issues/7'],
      [unknown.id, 'linear', 'workspace/FE', 'FE-2', 'https://linear.app/workspace/issue/FE-2'],
    ]) {
      await taskStore.database().run(sql`
        INSERT INTO ${taskExternalLinks}(task_id, provider, external_key, external_id, url)
        VALUES (${taskId}, ${provider}, ${externalKey}, ${externalId}, ${url})
      `)
    }

    const listed = (await taskStore.listTasks('local')).tasks
    expect(listed.map((task) => task.id).sort()).toEqual([known.id, unknown.id].sort())
    expect(listed.find((task) => task.id === known.id)?.mirroredTicket)
      .toMatchObject({ provider: 'github', externalId: '7' })
    expect(listed.find((task) => task.id === unknown.id)?.mirroredTicket).toBeUndefined()
  })

  test('publishes a first-dispatch bind only after its provider session is linked', async () => {
    // WHY: the bind happens before the session exists. Publishing it then
    // makes clients read a task that says it is in progress with no session
    // on it, until session_init links the two.
    const created = await taskStore.createTask('local', { title: 'One coherent task row', projectKey: '/workspace/solus' })
    let changes = 0
    const unsubscribe = taskStore.onTasksChanged(() => changes++)
    try {
      const task = await taskSessions.prepareSessionTask('local', {
        taskId: created.id,
        projectKey: '/workspace/solus',
      })

      expect(task).toMatchObject({ id: created.id, status: 'in_progress' })
      expect(changes).toBe(0)

      await (await tasks.Task.byId('local', task!.id)).linkSession('provider-session', 'working')

      expect(changes).toBe(1)
      expect(await taskSessions.tasksForSession('local', 'provider-session')).toMatchObject({
        task: { id: task!.id },
      })
    } finally {
      unsubscribe()
    }
  })

  test('a task has at most one lead session', async () => {
    // WHY: the lead owns the task page's conversation. A second lead would
    // change that conversation under the person reading it, so it is refused
    // rather than demoting the first (docs/plans/task-conversation.md).
    const task = await taskStore.createTask('local', { title: 'Led', projectKey: '/workspace/solus' })
    await (await tasks.Task.byId('local', task.id)).linkSession('lead-session', 'lead')
    await expect((await tasks.Task.byId('local', task.id)).linkSession('another-session', 'lead'))
      .rejects.toThrow('already has a lead session')
    // Re-linking the same lead, and adding workers, are both fine.
    await (await tasks.Task.byId('local', task.id)).linkSession('lead-session', 'lead')
    await (await tasks.Task.byId('local', task.id)).linkSession('worker-session', 'working')
    const links = (await taskSessions.taskSessions('local', task.id))[task.id]
    expect(links.map((link) => [link.sessionId, link.role])).toEqual([
      ['lead-session', 'lead'],
      ['worker-session', 'working'],
    ])
    // A lead owns its session like a working attempt: the session answers
    // for the task it leads.
    expect((await taskSessions.tasksForSession('local', 'lead-session'))?.task.id).toBe(task.id)
  })

  test('the first-dispatch bind refuses a lead for a task that has one', async () => {
    // WHY: the refusal must reach the client that asked, before any session
    // exists, so the composer can say so instead of a link failing later.
    const task = await taskStore.createTask('local', { title: 'Led', projectKey: '/workspace/solus' })
    await (await tasks.Task.byId('local', task.id)).linkSession('lead-session', 'lead')
    await expect(taskSessions.prepareSessionTask('local', { taskId: task.id, role: 'lead' }))
      .rejects.toThrow('already has a lead session')

    const fresh = await taskStore.createTask('local', { title: 'Unled', projectKey: '/workspace/solus' })
    await taskSessions.prepareSessionTask('local', { taskId: fresh.id, role: 'lead', sessionId: 'its-lead' })
    expect((await taskSessions.taskSessions('local', fresh.id))[fresh.id]?.[0]).toMatchObject({
      sessionId: 'its-lead',
      role: 'lead',
    })
  })

  test('files a worktree session under its base project', async () => {
    // WHY: conflict-resolution sessions execute in a managed PR worktree, but
    // the project-scoped sidebar must still include their task row.
    const created = await taskStore.createTask('local', { title: 'Resolve the PR conflicts' })
    const task = await taskSessions.prepareSessionTask('local', {
      taskId: created.id,
      projectKey: '/workspace/solus/.git/solus/worktrees/pr-47',
    })

    expect(task).toMatchObject({
      projectKey: '/workspace/solus',
    })
  })

  test('stores the six-state lifecycle and global inbox independently of project paths', async () => {
    // WHY: projectKey is a logical path used by history/sidebar grouping; it is
    // opaque store data and NULL, not a legacy hash, is the global inbox.
    const inbox = await taskStore.createTask('local', { title: 'Triage this later' })
    const project = await taskStore.createTask('local', {
      title: 'Ready work',
      projectKey: '/workspace/solus',
      status: 'todo',
      labels: ['backend'],
    })

    expect(inbox).toMatchObject({ projectKey: null, status: 'inbox', titleSource: 'manual', source: 'user' })
    expect(project).toMatchObject({ projectKey: '/workspace/solus', status: 'todo', labels: ['backend'] })
    expect(inbox.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(project.shortId).toBe((inbox.shortId ?? 0) + 1)
    expect((await taskStore.listTasks('local', { scope: 'inbox' })).tasks.map((task) => task.id)).toEqual([inbox.id])

    for (const status of ['in_progress', 'in_review', 'done', 'dropped', 'todo', 'inbox'] as const) {
      const updated = await (await tasks.Task.byId('local', project.id)).update({
        status,
        projectKey: status === 'inbox' ? null : '/workspace/solus',
      }, BY)
      expect(updated.status).toBe(status)
      if (status === 'done') expect(updated.doneAt).toEqual(expect.any(Number))
      else expect(updated.doneAt).toBeUndefined()
    }

    const detailed = await (await tasks.Task.byId('local', inbox.id)).comment('Local finding', { by: AGENT,
      originSessionId: 'session-comment',
    })
    expect(detailed.comments).toEqual([
      expect.objectContaining({
        taskId: inbox.id,
        author: AGENT,
        source: 'local',
        originSessionId: 'session-comment',
        body: 'Local finding',
      }),
    ])

    const commentId = detailed.comments[0]!.id
    const withoutComment = await (await tasks.Task.byId('local', inbox.id)).deleteComment(commentId, { by: BY, canModerate: false })
    // WHY: removing a task-page comment must remove only that first-class row;
    // reloading the task must not bring the comment back into Activity.
    expect(withoutComment.comments).toEqual([])
    expect((await (await tasks.Task.byId('local', inbox.id)).details()).comments).toEqual([])
    await expect((await tasks.Task.byId('local', inbox.id)).deleteComment(commentId, { by: BY, canModerate: true })).rejects.toThrow(
      'no longer exists',
    )

    const inboxTask = await tasks.Task.byId('local', inbox.id)
    expect(await inboxTask.delete()).toBe(true)
    expect(await inboxTask.delete()).toBe(false)
  })

  test('a person may delete their own comment, an editor may not delete another person\'s, the owner may', async () => {
    // WHY: any editor may comment on a task, but a comment is its author's
    // words. The host must refuse an editor deleting someone else's comment
    // (the client hiding the button is not enough), while the task's owner or
    // a host admin still moderates, as a work's threads do (mayChangeThread).
    const OTHER = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-2' }, displayName: 'Other User' } }
    const task = await taskStore.createTask('local', { title: 'Shared task' })
    const commentBy = async (by: typeof BY) => {
      const details = await (await tasks.Task.byId('local', task.id)).comment(`by ${by.user.id.accountId}`, { by })
      return details.comments.at(-1)!.id
    }
    const remaining = async () => (await (await tasks.Task.byId('local', task.id)).details()).comments.map((comment) => comment.body)

    const mine = await commentBy(BY)
    const theirs = await commentBy(OTHER)

    await expect((await tasks.Task.byId('local', task.id)).deleteComment(theirs, { by: BY, canModerate: false })).rejects.toThrow('Only the person who wrote a comment')
    expect(await remaining()).toEqual(['by user-1', 'by user-2'])

    await (await tasks.Task.byId('local', task.id)).deleteComment(mine, { by: BY, canModerate: false })
    expect(await remaining()).toEqual(['by user-2'])

    await (await tasks.Task.byId('local', task.id)).deleteComment(theirs, { by: BY, canModerate: true })
    expect(await remaining()).toEqual([])
  })

  test('an upstream epic is a snapshot only a provider read writes', async () => {
    // WHY: Solus never manages epics. The sync engine stores what the ticket
    // reported; a local edit must neither clear it nor queue it upstream.
    const { writeTaskEpic, externalLinkForTask } = await import('@solus/server/data/tasks/task-sync-store')
    const task = await taskStore.createTask('local', { title: 'Mirrored', projectKey: '/workspace/solus' })
    const epic = { provider: 'jira' as const, externalId: 'ACME-7', url: 'https://acme.atlassian.net/browse/ACME-7', title: 'Release 2.0', body: 'Ship it.' }
    const read = async () => (await tasks.Task.byId('local', task.id)).record().epic

    expect(await taskStore.database().transaction((db) => writeTaskEpic(db, task.id, epic))).toBe(true)
    expect(await read()).toEqual(epic)
    expect(await taskStore.database().transaction((db) => writeTaskEpic(db, task.id, epic))).toBe(false)

    await (await tasks.Task.byId('local', task.id)).update({ title: 'Renamed' }, BY)
    expect(await read()).toEqual(epic)
    expect(await externalLinkForTask(task.id)).toBeNull()

    // A read that cannot tell leaves the snapshot; a read that saw no epic clears it.
    await taskStore.database().transaction((db) => writeTaskEpic(db, task.id, undefined))
    expect(await read()).toEqual(epic)
    await taskStore.database().transaction((db) => writeTaskEpic(db, task.id, null))
    expect(await read()).toBeUndefined()
  })
})

describe('session binding and durable links', () => {
  test('exposes typed task methods for every workspace link kind', async () => {
    // WHY: callers should express domain identity (`workId`, plan pair,
    // `automationId`) instead of constructing task_links storage keys.
    const task = await taskStore.createTask('local', { title: 'Collect task context' })
    const instance = await tasks.Task.byId('local', task.id)

    await instance.linkWork('work-1', BY, { title: 'Architecture notes' })
    await instance.link({
      kind: 'work',
      targetScope: '/ignored/path',
      targetKey: 'work-1',
      title: 'Architecture notes',
    }, BY)
    await instance.linkPlan('session-plan', 'tool-plan', BY, { title: 'Implementation plan' })
    await instance.linkPlan('session-plan', 'tool-plan', BY, { title: 'Implementation plan' })
    await instance.linkAutomation('automation-1', BY, { title: 'Nightly verification' })
    const details = await instance.link({
      kind: 'automation',
      targetScope: '/ignored/path',
      targetKey: 'automation-1',
      title: 'Nightly verification',
    }, BY)

    expect(details.links.map((link) => ({
      kind: link.kind,
      targetScope: link.targetScope,
      targetKey: link.targetKey,
    }))).toEqual([
      { kind: 'automation', targetScope: '', targetKey: 'automation-1' },
      { kind: 'plan', targetScope: 'session-plan', targetKey: 'tool-plan' },
      { kind: 'work', targetScope: '', targetKey: 'work-1' },
    ])
  })

  test('attaches a PR discovered for a task session exactly once', async () => {
    // WHY: the PR list powers the sidebar chip, but the durable task link is
    // what makes the same PR appear on the task page and survive a refresh.
    const task = await taskWithSession('session-with-pr', 'Open the pull request')

    const pullRequest = {
      number: 321,
      title: '#321 Attach session PRs',
      url: 'https://github.com/acme/solus/pull/321',
      targetScope: '/workspace/solus',
    }
    const taskInstance = await tasks.Task.forSession('local', 'session-with-pr')
    expect(taskInstance?.id).toBe(task!.id)
    await taskInstance!.linkPullRequest({
      ...pullRequest,
      originSessionId: 'session-with-pr',
    }, AGENT)
    // Simulate a pre-canonical-URL snapshot. Rediscovery must repair the durable
    // edge itself, not only the task's compact capture.
    await taskStore.database().run(sql`
      UPDATE ${(await import('@solus/server/data/tasks/schema')).taskLinks}
      SET url = NULL, title = '#321', origin_session_id = NULL
      WHERE task_id = ${task!.id} AND kind = 'pr'
    `)
    await taskInstance!.linkPullRequest({
      ...pullRequest,
      originSessionId: 'session-with-pr',
    }, AGENT)

    const details = await (await tasks.Task.byId('local', task!.id)).details()
    expect(details.task.pr).toEqual({ number: 321, url: pullRequest.url })
    expect(details.links).toEqual([
      expect.objectContaining({
        kind: 'pr',
        targetScope: 'github.com/acme/solus',
        targetKey: '321',
        title: '#321 Attach session PRs',
        url: pullRequest.url,
        createdBy: AGENT,
        originSessionId: 'session-with-pr',
      }),
    ])
    expect(details.activity.filter((entry) => entry.kind === 'task_changed' && entry.change === 'linked')).toHaveLength(1)
    expect((await taskSessions.taskSessions('local', task!.id))[task!.id][0].pr).toEqual({
      number: 321,
      url: pullRequest.url,
    })
  })

  test('folds project-path and repository scopes for the same PR into one link', async () => {
    // WHY: the PR picker discovers from a project path while a pasted URL and
    // agent tool identify the repository. Those entry points still mean one PR.
    const task = await taskStore.createTask('local', {
      title: 'Keep one PR identity',
      projectKey: '/workspace/solus',
    })
    const taskInstance = await tasks.Task.byId('local', task.id)
    const url = 'https://github.com/acme/solus/pull/321'

    await taskInstance.linkPullRequest({
      number: 321,
      targetScope: '/workspace/solus',
      url,
      automatic: true,
      originSessionId: 'session-discovery',
    }, SYSTEM_ATTRIBUTION)
    const details = await taskInstance.linkPullRequest({
      number: 321,
      targetScope: 'github.com/acme/solus',
      url,
      title: '#321 One durable identity',
      originSessionId: 'session-explicit',
    }, AGENT)

    expect(details.links.filter((link) => link.kind === 'pr')).toEqual([
      expect.objectContaining({
        targetScope: 'github.com/acme/solus',
        targetKey: '321',
        url,
        title: '#321 One durable identity',
        originSessionId: 'session-explicit',
      }),
    ])
    expect(details.activity.filter((entry) => entry.kind === 'task_changed' && entry.change === 'linked')).toHaveLength(1)
  })

  test('keeps the session that established an automatic PR link', async () => {
    // WHY: two mounted checkouts can report the same pull request. If each
    // system write took the row over, every discovery pass would rewrite the
    // origin and title, and every rewrite broadcasts a task change that starts
    // the next pass. Explicit intent still wins.
    await taskWithSession('session-first-observer', 'Observe the pull request')
    const taskInstance = await tasks.Task.forSession('local', 'session-first-observer')
    const pullRequest = {
      number: 322,
      url: 'https://github.com/acme/solus/pull/322',
      targetScope: '/workspace/solus',
    }
    await taskInstance!.linkPullRequest({
      ...pullRequest,
      title: '#322 Shared pull request',
      originSessionId: 'session-first-observer',
      automatic: true,
    }, SYSTEM_ATTRIBUTION)
    const second = await taskInstance!.linkPullRequest({
      ...pullRequest,
      title: '#322',
      originSessionId: 'session-second-observer',
      automatic: true,
    }, SYSTEM_ATTRIBUTION)

    expect(second.links.filter((link) => link.kind === 'pr')).toEqual([
      expect.objectContaining({
        targetKey: '322',
        title: '#322 Shared pull request',
        originSessionId: 'session-first-observer',
      }),
    ])

    const claimed = await taskInstance!.linkPullRequest({
      ...pullRequest,
      title: '#322 Renamed by the user',
      originSessionId: 'session-second-observer',
    }, BY)
    expect(claimed.links.filter((link) => link.kind === 'pr')).toEqual([
      expect.objectContaining({
        targetKey: '322',
        title: '#322 Renamed by the user',
        originSessionId: 'session-second-observer',
      }),
    ])
  })

  test('links session artifacts to the owning task exactly once', async () => {
    // WHY: artifacts created or edited by an agent must remain discoverable
    // from its task without repeated edits producing duplicate activity.
    const task = await taskWithSession('session-with-artifacts', 'Create the task artifacts')

    const link = {
      kind: 'work' as const,
      targetKey: 'work-from-session',
      title: 'Session notes',
    }
    await tasks.Task.linkSessionOutput('local', 'session-with-artifacts', link)
    await tasks.Task.linkSessionOutput('local', 'session-with-artifacts', link)

    const details = await (await tasks.Task.byId('local', task!.id)).details()
    expect(details.links).toEqual([
      expect.objectContaining({
        kind: 'work',
        targetKey: 'work-from-session',
        createdBy: { kind: 'agent', sessionId: 'session-with-artifacts' },
        originSessionId: 'session-with-artifacts',
      }),
    ])
    expect(details.activity.filter((entry) => entry.kind === 'task_changed' && entry.change === 'linked')).toHaveLength(1)
  })

  test('a second session bound to a task is a sibling attempt, not a child task', async () => {
    // WHY: tasks own multiple session attempts. Starting another session under
    // the active task must reuse that task instead of minting prompt-path
    // hierarchy that changes the task count.
    const root = await taskStore.createTask('local', {
      title: 'The task on screen',
      projectKey: '/workspace/solus',
    })

    await taskSessions.prepareSessionTask('local', {
      taskId: root.id,
      sessionId: 'session-first-attempt',
      projectKey: '/workspace/solus',
    })
    await taskSessions.prepareSessionTask('local', {
      taskId: root.id,
      sessionId: 'session-second-attempt',
      projectKey: '/workspace/solus',
    })

    const tasks = (await taskStore.listTasks('local')).tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe(root.id)
    expect((await taskSessions.taskSessions('local', root.id))[root.id]).toEqual([
      expect.objectContaining({ taskId: root.id, sessionId: 'session-first-attempt' }),
      expect.objectContaining({ taskId: root.id, sessionId: 'session-second-attempt' }),
    ])
  })

  test('task session links include indexed session chronology and display metadata', async () => {
    // WHY: closed attempts have no mounted renderer session, so the sidebar
    // needs their persisted display and model metadata on the durable task link.
    const task = await taskWithSession('session-with-metadata', 'Raw session prompt')
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, first_message, custom_title, last_timestamp, model)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'session-with-metadata',
      'codex',
      'First session message',
      'Named session',
      1_725_000_000_000,
      'gpt-5.6-sol',
    )
    db.getDb().prepare(`
      INSERT INTO session_lineage_members(
        session_id, position, provider, provider_session_id, cwd, started_at, updated_at
      ) VALUES (?, 0, ?, ?, ?, ?, ?)
    `).run(
      'session-with-metadata',
      'codex',
      'session-with-metadata',
      '/workspace/solus',
      1_724_000_000_000,
      1_725_000_000_000,
    )
    db.getDb().prepare(`
      INSERT INTO session_lineage_members(
        session_id, position, provider, provider_session_id, cwd, started_at, updated_at
      ) VALUES (?, 1, ?, NULL, ?, ?, ?)
    `).run(
      'session-with-metadata',
      'codex',
      '/workspace/solus',
      1_724_500_000_000,
      1_725_000_000_000,
    )

    expect((await taskSessions.taskSessions('local', task!.id))[task!.id]).toEqual([
      expect.objectContaining({
        sessionId: 'session-with-metadata',
        sessionTitle: 'Named session',
        model: 'gpt-5.6-sol',
        startedAt: 1_724_000_000_000,
        lastActivityAt: 1_725_000_000_000,
      }),
    ])
    expect((await taskSessions.tasksForSession('local', 'session-with-metadata'))?.attempts).toEqual([
      expect.objectContaining({
        sessionId: 'session-with-metadata',
        sessionTitle: 'Named session',
        model: 'gpt-5.6-sol',
        startedAt: 1_724_000_000_000,
        lastActivityAt: 1_725_000_000_000,
      }),
    ])
  })

  test('unlinking a session removes the attempt and records who detached what', async () => {
    // WHY: linking a session has always had no way out. Unlink must remove
    // exactly one attempt row, keep the activity feed able to say which
    // session left by name, and stay silent when there is nothing to remove.
    const task = await taskWithSession('session-to-unlink', 'Attempt that gets detached')
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, first_message, custom_title, last_timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-to-unlink', 'claude-code', 'First message', 'Detached session', 1_725_000_000_000)

    const bag = await tasks.Task.byId('local', task!.id)
    await bag.unlinkSession('session-to-unlink', BY)

    expect((await taskSessions.taskSessions('local', task!.id))[task!.id]).toBeUndefined()
    const unlinked = (await bag.details()).activity.filter((entry) => entry.kind === 'task_changed' && entry.change === 'unlinked')
    expect(unlinked).toEqual([
      expect.objectContaining({
        target: { kind: 'session', key: 'session-to-unlink', title: 'Detached session' },
        by: BY,
      }),
    ])

    // A second unlink is a no-op: no error, and no second history entry.
    await bag.unlinkSession('session-to-unlink', BY)
    expect((await bag.details()).activity.filter((entry) => entry.kind === 'task_changed' && entry.change === 'unlinked')).toHaveLength(1)
  })

  test('the detail read carries no session links at all', async () => {
    // WHY: a task's attempts have exactly one reader, `taskSessions()`, whose
    // join is what gives every link its display metadata. A second copy on the
    // detail payload was written straight over the renderer's good links by
    // whichever surface opened first, renaming every session in the sidebar
    // after its parent task and every row in the task panel after its id.
    // Not "kept in sync" — absent, so the disagreement cannot be expressed.
    const task = await taskWithSession('session-detail', 'A task with one attempt')

    const details = await (await tasks.Task.byId('local', task!.id)).details()
    expect(details).not.toHaveProperty('attempts')
    expect((await taskSessions.taskSessions('local', task!.id))[task!.id]).toHaveLength(1)
  })

  test.each([
    ['claude', 'claude-code'],
    ['claude-code', 'claude-code'],
    ['codex', 'codex'],
    ['opencode', 'opencode'],
  ])('task attempts normalize stored %s metadata through the stable lineage id', async (storedProvider, provider) => {
    const task = await taskWithSession('stable-session', 'A task with a stable session id')
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, first_message, custom_title, last_timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run('provider-session', storedProvider, 'First provider message', 'Provider session title', 1_725_000_000_000)
    db.getDb().prepare(`
      INSERT INTO session_lineage_members(
        session_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('stable-session', 0, provider, 'provider-session', '/workspace/solus', 1, null, 1)

    expect((await taskSessions.taskSessions('local', task!.id))[task!.id]).toEqual([
      expect.objectContaining({
        sessionId: 'stable-session',
        sessionTitle: 'Provider session title',
        provider,
      }),
    ])
    // A stored Claude name must not block the snapshot for every task.
    const { readTaskSidebarSnapshot } = await import('@solus/server/data/tasks/task-sidebar')
    expect((await readTaskSidebarSnapshot('local')).sessionsByTask[task!.id][0].provider).toBe(provider)
  })

  test('performs no write for any dispatch with an existing provider session', async () => {
    // WHY: the bind belongs to a session's first dispatch. A follow-up prompt
    // that names a task must not move the task or link the session again.
    const task = await taskStore.createTask('local', { title: 'Named by a follow-up', projectKey: '/workspace/solus' })
    for (let prompt = 0; prompt < 3; prompt++) {
      expect(await taskSessions.prepareSessionTask('local', {
        existingAgentSessionId: 'provider-session-already-started',
        taskId: task.id,
        sessionId: 'started-solus-session',
        projectKey: '/workspace/solus',
      })).toBeNull()
    }
    expect(await taskStore.loadTaskRecord('local', task.id)).toMatchObject({ status: 'todo' })
    expect(await taskSessions.tasksForSession('local', 'started-solus-session')).toBeNull()
  })

  test('manual session rename does not rename a task shared by other sessions', async () => {
    // WHY: the sidebar can group several distinct attempts under one task. A
    // session rename belongs to one attempt and must not replace the shared
    // row's task title or make its sibling sessions appear to share a name.
    const task = await taskWithSession('first-session', 'Shared task title')
    await (await tasks.Task.byId('local', task!.id)).linkSession('second-session', 'working')
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, first_message, custom_title, last_timestamp)
      VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
    `).run(
      'first-session', 'codex', 'First prompt', 'First session name', 1,
      'second-session', 'codex', 'Second prompt', 'Second session name', 2,
    )

    const { SolusServer } = await import('@solus/server/transport/server')
    const { registerHistoryHandlers } = await import('@solus/server/transport/handlers/history-handlers')
    const { HostEventPublisher } = await import('@solus/server/transport/events/host-event-publisher')
    const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
    const server = new SolusServer()
    // SAFETY: this test invokes only setSessionTitle, whose handler does not
    // read SessionRuntime. The empty object prevents unrelated handler work.
    const sessionRuntime = {} as never
    registerHistoryHandlers(server, {
      sessionRuntime,
      events: new HostEventPublisher(new ClientEventRegistry()),
      agentIdFromContext: () => 'codex',
    })

    await server.handle('setSessionTitle', ['second-session', 'Renamed second session', 'manual'], testHandlerCtx)

    expect((await tasks.Task.byId('local', task!.id)).record()).toMatchObject({
      title: 'Shared task title',
    })
    expect((await taskSessions.taskSessions('local', task!.id))[task!.id].map((link) => link.sessionTitle))
      .toEqual(['First session name', 'Renamed second session'])
  })

  test('explicit binding stamps provenance on the attempt', async () => {
    const task = await taskStore.createTask('local', { title: 'Existing task' })
    const bound = await taskSessions.prepareSessionTask('local', {
      taskId: task.id,
      projectKey: '/workspace/solus',
    })
    expect(bound).toMatchObject({
      projectKey: '/workspace/solus',
      status: 'in_progress',
    })
    const bag = await tasks.Task.byId('local', task.id)
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, size, branch)
      VALUES (?, 'codex', 0, ?, 0, ?)
    `).run('bound-session', Date.now(), 'feature/bound')
    await bag.linkSession('bound-session', 'working', {
      originSessionId: 'provider-session',
    })
    await taskStore.database().run(sql`
      UPDATE ${(await import('@solus/server/data/tasks/schema')).taskSessionLinks}
      SET linked_at = 1 WHERE task_id = ${task.id} AND session_id = ${'bound-session'}
    `)
    // An explicit idempotent retry does not create new history or move the row.
    await bag.linkSession('bound-session', 'working', {})

    const detail = await bag.details()
    expect(detail.task).toMatchObject({ originSessionId: 'provider-session' })
    expect(detail.task).not.toHaveProperty('branch')
    expect((await taskSessions.taskSessions('local', task.id))[task.id]).toEqual([
      expect.objectContaining({
        sessionId: 'bound-session',
        branch: 'feature/bound',
        linkedAt: 1,
      }),
    ])
  })

  test('an attempt says whether its branch is a worktree or a shared clone', async () => {
    // WHY: a branch is only evidence that this session produced a pull request
    // when the checkout belongs to the session. Git state is per working
    // directory, so every attempt open on one clone reports the same branch —
    // recording that let one feature branch claim 33 unrelated tasks. Discovery
    // reads this flag to decide, so the projection has to survive the join.
    const shared = await taskStore.createTask('local', { title: 'Shared clone attempt' })
    const isolated = await taskStore.createTask('local', { title: 'Worktree attempt' })
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, size, branch)
      VALUES (?, 'claude', ?, ?, 0, ?)
    `).run('clone-session', 0, Date.now(), 'feature/shared')
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, size, branch)
      VALUES (?, 'claude', ?, ?, 0, ?)
    `).run('worktree-session', 1, Date.now(), 'feature/isolated')
    await (await tasks.Task.byId('local', shared.id)).linkSession('clone-session', 'working', {})
    await (await tasks.Task.byId('local', isolated.id)).linkSession('worktree-session', 'working', {})

    expect((await taskSessions.taskSessions('local', shared.id))[shared.id]).toEqual([
      expect.objectContaining({ sessionId: 'clone-session', isolatedCheckout: false }),
    ])
    expect((await taskSessions.taskSessions('local', isolated.id))[isolated.id]).toEqual([
      expect.objectContaining({ sessionId: 'worktree-session', isolatedCheckout: true }),
    ])
  })

  test('an attempt whose session is not indexed claims no checkout', async () => {
    // WHY: undefined has to stay distinguishable from false. A link written
    // before its session reaches the index must not read as "shared clone,
    // proven" — it is simply unanswered, and discovery treats it as no claim.
    const task = await taskStore.createTask('local', { title: 'Unindexed attempt' })
    await (await tasks.Task.byId('local', task.id)).linkSession('unindexed-session', 'working', {})

    const [attempt] = (await taskSessions.taskSessions('local', task.id))[task.id] ?? []
    expect(attempt).toBeDefined()
    expect(attempt).not.toHaveProperty('isolatedCheckout')
  })

  test('a dispatched attempt remembers the host it ran on', async () => {
    const task = await taskStore.createTask('local', { title: 'Dispatched task' })
    const bag = await tasks.Task.byId('local', task.id)
    // The client is the only party that can name the execution host — this host
    // is the task's, and it never sees the agent. Without that the attempt is
    // indistinguishable from one that ran here, and every closed-session row
    // reads as local.
    await bag.linkSession('dispatched-session', 'working', {
      execution: { serverId: 'studio', provider: 'claude-code', projectRoot: '/repo' },
    })
    await bag.linkSession('local-session', 'working', { execution: null })
    // Re-linking carries no host — it must not erase the one already recorded.
    await bag.linkSession('dispatched-session', 'working', {})

    // Keyed rather than ordered because this assertion concerns only the host.
    const hostBySession = Object.fromEntries(
      (await taskSessions.taskSessions('local', task.id))[task.id].map(
        (link) => [link.sessionId, link.executionServerId],
      ),
    )
    expect(hostBySession).toEqual({
      'dispatched-session': 'studio',
      'local-session': null,
    })
  })

  test('the host lands on the session record, so every link to it agrees', async () => {
    // WHY: a session worked on by two tasks has a link each. Keeping the host on
    // the session means the second link is right without being told, and there
    // is one row to correct rather than one per referrer.
    const first = await taskStore.createTask('local', { title: 'Dispatched task' })
    const second = await taskStore.createTask('local', { title: 'Task that references it' })
    await (await tasks.Task.byId('local', first.id)).linkSession('shared-session', 'working', {
      execution: { serverId: 'studio', provider: 'claude-code', projectRoot: '/repo' },
    })
    await (await tasks.Task.byId('local', second.id)).linkSession('shared-session', 'referenced')

    const links = await taskSessions.taskSessions('local')
    expect(links[second.id]).toEqual([
      expect.objectContaining({ sessionId: 'shared-session', executionServerId: 'studio' }),
    ])
    // The stub session row also carries the agent, so the task's host can name
    // it without ever holding the transcript.
    expect(links[first.id][0].provider).toBe('claude-code')
  })
})

describe('one owning task per session', () => {
  test('moving between two user tasks keeps both and records the departure', async () => {
    const first = await taskStore.createTask('local', { title: 'First home' })
    const second = await taskStore.createTask('local', { title: 'Second home' })
    await (await tasks.Task.byId('local', first.id)).linkSession('restless-session', 'working')

    await (await tasks.Task.byId('local', second.id)).linkSession('restless-session', 'working')

    const links = await taskSessions.taskSessions('local')
    expect(links[first.id]).toBeUndefined()
    expect(links[second.id]).toHaveLength(1)
    expect(await taskStore.loadTaskRecord('local', first.id)).not.toBeNull()
    const firstDetails = await (await tasks.Task.byId('local', first.id)).details()
    expect(firstDetails.activity.map((entry) => entry.kind === 'task_changed' && entry.change)).toContain('unlinked')
  })

  test('a referenced link neither moves the session nor outranks its owner', async () => {
    // WHY: referencing a session from a second task is a relationship, not a
    // move. The owner keeps answering for the session even though the reference
    // is the newer row — "latest link wins" is what used to hand it over.
    const owner = await taskStore.createTask('local', { title: 'Owner' })
    const referrer = await taskStore.createTask('local', { title: 'Referrer' })
    await (await tasks.Task.byId('local', owner.id)).linkSession('shared-session', 'working')
    await taskStore.database().run(sql`
      UPDATE ${(await import('@solus/server/data/tasks/schema')).taskSessionLinks} SET linked_at = 1 WHERE task_id = ${owner.id}
    `)

    await (await tasks.Task.byId('local', referrer.id)).linkSession('shared-session', 'referenced')

    const links = await taskSessions.taskSessions('local')
    expect(links[owner.id]).toEqual([
      expect.objectContaining({ sessionId: 'shared-session', role: 'working' }),
    ])
    expect(links[referrer.id]).toEqual([
      expect.objectContaining({ sessionId: 'shared-session', role: 'referenced' }),
    ])
    expect(await taskSessions.tasksForSession('local', 'shared-session')).toMatchObject({
      task: { id: owner.id },
    })
    expect((await tasks.Task.forSession('local', 'shared-session'))?.id).toBe(owner.id)
  })

})
