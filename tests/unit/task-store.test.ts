import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/tasks/task-store')
type TaskModule = typeof import('@solus/server/tasks/task')
type TaskSessionsModule = typeof import('@solus/server/tasks/task-sessions')
type TaskLinksModule = typeof import('@solus/server/tasks/task-links')
type UlidModule = typeof import('@solus/contracts/ulid')

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let taskSessions: TaskSessionsModule
let taskLinks: TaskLinksModule
let ids: UlidModule
let migrationsFolder: typeof import('@solus/server/db/migration-files').migrationsFolder
let testHandlerCtx: import('@solus/server/server/server').HandlerCtx
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-store-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/tasks/task-store')
  tasks = await import('@solus/server/tasks/task')
  taskSessions = await import('@solus/server/tasks/task-sessions')
  taskLinks = await import('@solus/server/tasks/task-links')
  ids = await import('@solus/contracts/ulid')
  ;({ migrationsFolder } = await import('@solus/server/db/migration-files'))
  testHandlerCtx = (await import('./helpers/handler-ctx')).TEST_HANDLER_CTX
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

describe('native task migration', () => {
  test('ULIDs preserve timestamp ordering in their canonical text form', () => {
    expect(ids.ulid(10)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(ids.ulid(10) < ids.ulid(11)).toBe(true)
    expect(() => ids.ulid(-1)).toThrow('ULID timestamp')
  })

  // The file is the store only on SQLite; on Postgres these tables are not in it.
  test.skipIf(process.env.SOLUS_DB === 'postgres')('the ported tables come from the generated migration; a file that already has them opens as it is', async () => {
    // WHY: the hand-written migrations no longer create task tables, and a
    // developer's existing solus.db already holds them in their last hand-made
    // shape. Both files must open: the generated migration is `IF NOT EXISTS`.
    const fresh = db.getDb()
    const ported = [
      'asset_publications', 'task_comments', 'task_counters', 'task_events', 'task_external_links',
      'task_links', 'task_session_links', 'tasks', 'upstream_task_cache',
    ]
    const tables = () => db.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%task%' OR name = 'asset_publications' ORDER BY name",
    ).all().map((row) => (row as { name: string }).name)
    expect(tables()).toEqual(ported)
    const generated = readdirSync(migrationsFolder('sqlite')).filter((file) => file.endsWith('.sql')).length
    expect(fresh.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: generated })
    db.closeDb()
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })

    const legacy = new Database(join(dataDir, 'solus.db'))
    legacy.exec(`
      PRAGMA user_version = 1000;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        short_id INTEGER UNIQUE,
        project_key TEXT,
        parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'inbox',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO tasks(id, short_id, title, created_at, updated_at) VALUES ('kept', 1, 'A task from before', 1, 1);
    `)
    legacy.close()

    const reopened = db.getDb()
    expect(tables()).toEqual(ported)
    // The hand-made table gains the columns the ported schema declares, so the
    // rows it already held are the host's own organization's.
    expect(reopened.prepare('SELECT id, organization_id FROM tasks').all()).toEqual([{ id: 'kept', organization_id: 'local' }])
    expect((await taskStore.listTasks('local')).tasks.map((task) => task.id)).toEqual(['kept'])
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
    // WHY: agent link_task calls can identify a PR by number without a URL.
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
      createdBy: 'agent',
      originSessionId: 'session-43',
    })
    await (await tasks.Task.byId('local', task.id)).link({
      kind: 'pr',
      targetScope: 'github.com/other/repo',
      targetKey: '43',
      title: '#43 other/repo',
      url: 'https://github.com/other/repo/pull/43',
      createdBy: 'user',
    })

    expect(await taskLinks.readTaskPrLinks(taskStore.database(), 'local')).toEqual({
      [task.id]: [
        {
          number: 43,
          title: '#43 other/repo',
          targetScope: 'github.com/other/repo',
          url: 'https://github.com/other/repo/pull/43',
          createdBy: 'user',
        },
        {
          number: 43,
          title: '#43',
          targetScope: 'github.com/solus-sh/solus',
          url: 'https://github.com/solus-sh/solus/pull/43',
          createdBy: 'agent',
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
    const { taskExternalLinks } = await import('@solus/server/tasks/schema')
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

  test('publishes a session-born task only after its provider session is linked', async () => {
    // WHY: a pre-launch task without a session link appears beside the loose
    // renderer session as a duplicate row until session_init links the two.
    let changes = 0
    const unsubscribe = taskStore.onTasksChanged(() => changes++)
    try {
      const task = await taskSessions.prepareSessionTask('local', {
        projectKey: '/workspace/solus',
        prompt: 'Start one coherent task row',
      })

      expect(task).not.toBeNull()
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

  test('mints a session-born task under the id its client already shows', async () => {
    // WHY: the sidebar draws the new session's row before this call returns.
    // Minting under a fresh id made the task arrive as a second row, which the
    // list faded in over the first one just as it settled.
    const clientId = ids.ulid()
    const task = await taskSessions.prepareSessionTask('local', {
      taskId: clientId,
      projectKey: '/workspace/solus',
      prompt: 'Keep one row',
    })
    expect(task?.id).toBe(clientId)

    const parentId = task!.id
    const subtaskId = ids.ulid()
    const subtask = await taskSessions.prepareSessionTask('local', {
      taskId: subtaskId,
      parentTaskId: parentId,
      projectKey: '/workspace/solus',
      prompt: 'Fork it',
    })
    expect(subtask).toMatchObject({ id: subtaskId, parentId })
  })

  test('refuses a client-minted id that is malformed, taken, or beside a bound task', async () => {
    // WHY: one id names one task. Two sessions arriving with one id is a client
    // bug, so the second must fail loudly instead of joining the first task.
    await expect(taskSessions.prepareSessionTask('local', { taskId: 'not-a-ulid', prompt: 'x' }))
      .rejects.toThrow('not a ULID')

    const taken = ids.ulid()
    await taskSessions.prepareSessionTask('local', { taskId: taken, prompt: 'first' })
    await expect(taskSessions.prepareSessionTask('local', { taskId: taken, prompt: 'second' }))
      .rejects.toThrow('already exists')

    const existing = await taskStore.createTask('local', { title: 'Bound' })
    await expect(taskSessions.prepareSessionTask('local', {
      existingTaskId: existing.id,
      taskId: ids.ulid(),
    })).rejects.toThrow('cannot bind an existing task and name a new one')
  })

  test('files a worktree session under its base project', async () => {
    // WHY: conflict-resolution sessions execute in a managed PR worktree, but
    // the project-scoped sidebar must still include their task row.
    const task = await taskSessions.prepareSessionTask('local', {
      projectKey: '/workspace/solus/.git/solus/worktrees/pr-47',
      prompt: 'Resolve the PR conflicts',
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
      })
      expect(updated.status).toBe(status)
      if (status === 'done') expect(updated.doneAt).toEqual(expect.any(Number))
      else expect(updated.doneAt).toBeUndefined()
    }

    const detailed = await (await tasks.Task.byId('local', inbox.id)).comment('Local finding', {
      author: 'agent',
      originSessionId: 'session-comment',
    })
    expect(detailed.comments).toEqual([
      expect.objectContaining({
        taskId: inbox.id,
        author: 'agent',
        source: 'local',
        originSessionId: 'session-comment',
        body: 'Local finding',
      }),
    ])

    const commentId = detailed.comments[0]!.id
    const withoutComment = await (await tasks.Task.byId('local', inbox.id)).deleteComment(commentId)
    // WHY: removing a task-page comment must remove only that first-class row;
    // reloading the task must not bring the comment back into Activity.
    expect(withoutComment.comments).toEqual([])
    expect((await (await tasks.Task.byId('local', inbox.id)).details()).comments).toEqual([])
    await expect((await tasks.Task.byId('local', inbox.id)).deleteComment(commentId)).rejects.toThrow(
      'no longer exists',
    )

    const inboxTask = await tasks.Task.byId('local', inbox.id)
    expect(await inboxTask.delete()).toBe(true)
    expect(await inboxTask.delete()).toBe(false)
  })

  test('cascades subtask deletion and rejects a third hierarchy level', async () => {
    const parent = await taskStore.createTask('local', { title: 'Parent', projectKey: '/workspace/solus' })
    const child = await taskStore.createTask('local', { title: 'Child', parentId: parent.id })

    await expect(taskStore.createTask('local', { title: 'Grandchild', parentId: child.id })).rejects.toThrow(
      'Subtasks cannot contain nested subtasks.',
    )
    expect((await (await tasks.Task.byId('local', parent.id)).details()).subtasks.map((task) => task.id)).toEqual([child.id])
    expect(await (await tasks.Task.byId('local', parent.id)).delete()).toBe(true)
    expect((await taskStore.listTasks('local')).tasks).toEqual([])
  })
})

describe('session minting and durable links', () => {
  test('exposes typed task methods for every workspace link kind', async () => {
    // WHY: callers should express domain identity (`workId`, plan pair,
    // `automationId`) instead of constructing task_links storage keys.
    const task = await taskStore.createTask('local', { title: 'Collect task context' })
    const instance = await tasks.Task.byId('local', task.id)

    await instance.linkWork('work-1', { title: 'Architecture notes' })
    await instance.link({
      kind: 'work',
      targetScope: '/ignored/path',
      targetKey: 'work-1',
      title: 'Architecture notes',
    })
    await instance.linkPlan('session-plan', 'tool-plan', { title: 'Implementation plan' })
    await instance.linkPlan('session-plan', 'tool-plan', { title: 'Implementation plan' })
    await instance.linkAutomation('automation-1', { title: 'Nightly verification' })
    const details = await instance.link({
      kind: 'automation',
      targetScope: '/ignored/path',
      targetKey: 'automation-1',
      title: 'Nightly verification',
    })

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
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-with-pr',
      projectKey: '/workspace/solus',
      prompt: 'Open the pull request',
    })

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
      createdBy: 'agent',
    })
    // Simulate a pre-canonical-URL snapshot. Rediscovery must repair the durable
    // edge itself, not only the task's compact capture.
    await taskStore.database().run(sql`
      UPDATE ${(await import('@solus/server/tasks/schema')).taskLinks}
      SET url = NULL, title = '#321', origin_session_id = NULL
      WHERE task_id = ${task!.id} AND kind = 'pr'
    `)
    await taskInstance!.linkPullRequest({
      ...pullRequest,
      originSessionId: 'session-with-pr',
      createdBy: 'agent',
    })

    const details = await (await tasks.Task.byId('local', task!.id)).details()
    expect(details.task.pr).toEqual({ number: 321, url: pullRequest.url })
    expect(details.links).toEqual([
      expect.objectContaining({
        kind: 'pr',
        targetScope: 'github.com/acme/solus',
        targetKey: '321',
        title: '#321 Attach session PRs',
        url: pullRequest.url,
        createdBy: 'agent',
        originSessionId: 'session-with-pr',
      }),
    ])
    expect(details.events.filter((event) => event.kind === 'linked')).toHaveLength(1)
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
      createdBy: 'system',
      originSessionId: 'session-discovery',
    })
    const details = await taskInstance.linkPullRequest({
      number: 321,
      targetScope: 'github.com/acme/solus',
      url,
      title: '#321 One durable identity',
      createdBy: 'agent',
      originSessionId: 'session-explicit',
    })

    expect(details.links.filter((link) => link.kind === 'pr')).toEqual([
      expect.objectContaining({
        targetScope: 'github.com/acme/solus',
        targetKey: '321',
        url,
        title: '#321 One durable identity',
        originSessionId: 'session-explicit',
      }),
    ])
    expect(details.events.filter((event) => event.kind === 'linked')).toHaveLength(1)
  })

  test('replaces stale automatic PR identity for the same session', async () => {
    // WHY: a checkout can move to another branch while its task stays open. The
    // latest Git-status answer replaces that session's old system discovery;
    // explicit user and agent links remain independent history.
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-moving-pr',
      projectKey: '/workspace/solus',
      prompt: 'Move between pull requests',
    })
    const taskInstance = await tasks.Task.forSession('local', 'session-moving-pr')
    await taskInstance!.linkPullRequest({
      number: 320,
      url: 'https://github.com/acme/solus/pull/320',
      targetScope: '/workspace/solus',
      originSessionId: 'session-moving-pr',
      createdBy: 'system',
    })
    await taskInstance!.linkPullRequest({
      number: 321,
      url: 'https://github.com/acme/solus/pull/321',
      targetScope: '/workspace/solus',
      originSessionId: 'session-moving-pr',
      createdBy: 'system',
    })

    expect((await (await tasks.Task.byId('local', task!.id)).details()).links
      .filter((link) => link.kind === 'pr')
      .map((link) => link.targetKey)).toEqual(['321'])
  })

  test('keeps the session that established an automatic PR link', async () => {
    // WHY: two mounted checkouts can report the same pull request. If each
    // system write took the row over, every discovery pass would rewrite the
    // origin and title, and every rewrite broadcasts a task change that starts
    // the next pass. Explicit intent still wins.
    await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-first-observer',
      projectKey: '/workspace/solus',
      prompt: 'Observe the pull request',
    })
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
      createdBy: 'system',
    })
    const second = await taskInstance!.linkPullRequest({
      ...pullRequest,
      title: '#322',
      originSessionId: 'session-second-observer',
      createdBy: 'system',
    })

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
      createdBy: 'user',
    })
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
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-with-artifacts',
      projectKey: '/workspace/solus',
      prompt: 'Create the task artifacts',
    })

    const link = {
      kind: 'work' as const,
      targetKey: 'work-from-session',
      title: 'Session notes',
    }
    await tasks.Task.linkArtifactForSession('local', 'session-with-artifacts', link)
    await tasks.Task.linkArtifactForSession('local', 'session-with-artifacts', link)

    const details = await (await tasks.Task.byId('local', task!.id)).details()
    expect(details.links).toEqual([
      expect.objectContaining({
        kind: 'work',
        targetKey: 'work-from-session',
        createdBy: 'agent',
        originSessionId: 'session-with-artifacts',
      }),
    ])
    expect(details.events.filter((event) => event.kind === 'linked')).toHaveLength(1)
  })

  test('keeps independent sessions as top-level tasks even when they share a worktree', async () => {
    // WHY: a worktree is execution context shared by many unrelated sessions.
    // Inferring hierarchy from it makes every later session appear under the
    // first task on `main`; only the tasks page may group task rows.
    const root = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-root',
      projectKey: '/workspace/solus',
      prompt: '\n  Build the durable tasks foundation with an intentionally very long suffix that is clipped\nMore',
    })
    const child = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-child',
      projectKey: '/workspace/solus',
      prompt: 'Add focused tests',
    })
    const sibling = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-sibling',
      projectKey: '/workspace/solus',
      prompt: 'Verify migration',
    })

    expect(root).not.toBeNull()
    expect(child).not.toBeNull()
    expect(sibling).not.toBeNull()
    expect(root!).toMatchObject({ status: 'in_progress', source: 'session' })
    expect(root!.parentId).toBeUndefined()
    expect(Array.from(root!.title)).toHaveLength(80)
    expect(child!.parentId).toBeUndefined()
    expect(sibling!.parentId).toBeUndefined()
    expect((await taskSessions.taskSessions('local'))[root!.id]).toEqual([
      expect.objectContaining({ sessionId: 'session-root', role: 'working' }),
    ])
    expect((await taskSessions.tasksForSession('local', 'session-child'))).toMatchObject({
      task: { id: child!.id },
      parent: null,
      siblings: [],
      attempts: [expect.objectContaining({ taskId: child!.id, sessionId: 'session-child' })],
    })
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
      existingTaskId: root.id,
      sessionId: 'session-first-attempt',
      projectKey: '/workspace/solus',
      prompt: 'Try the first approach',
    })
    await taskSessions.prepareSessionTask('local', {
      existingTaskId: root.id,
      sessionId: 'session-second-attempt',
      projectKey: '/workspace/solus',
      prompt: 'Try a different approach',
    })

    const tasks = (await taskStore.listTasks('local')).tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe(root.id)
    expect(tasks[0].parentId).toBeUndefined()
    expect((await taskSessions.taskSessions('local', root.id))[root.id]).toEqual([
      expect.objectContaining({ taskId: root.id, sessionId: 'session-first-attempt' }),
      expect.objectContaining({ taskId: root.id, sessionId: 'session-second-attempt' }),
    ])
  })

  test('can mint a session-born subtask beneath an explicit parent', async () => {
    // WHY: agent-created worker sessions must carry task hierarchy at first
    // dispatch so their initial system prompt already names the parent and
    // sibling work instead of relying on a racy follow-up link.
    const parent = await taskStore.createTask('local', {
      title: 'Ship task-aware tools',
      projectKey: '/workspace/solus',
    })

    const child = await taskSessions.prepareSessionTask('local', {
      parentTaskId: parent.id,
      sessionId: 'session-child-worker',
      projectKey: '/workspace/solus',
      prompt: 'Add focused coverage',
    })

    expect(child).toMatchObject({
      parentId: parent.id,
      title: 'Add focused coverage',
      status: 'in_progress',
      source: 'session',
    })
    expect(await taskSessions.tasksForSession('local', 'session-child-worker')).toMatchObject({
      task: { id: child!.id, parentId: parent.id },
      parent: { id: parent.id },
    })
  })

  test('task session links include indexed session chronology and display metadata', async () => {
    // WHY: closed attempts have no mounted renderer session, so the sidebar
    // needs their persisted display and model metadata on the durable task link.
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-with-metadata',
      projectKey: '/workspace/solus',
      prompt: 'Raw session prompt',
    })
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
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-to-unlink',
      projectKey: '/workspace/solus',
      prompt: 'Attempt that gets detached',
    })
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, first_message, custom_title, last_timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-to-unlink', 'claude-code', 'First message', 'Detached session', 1_725_000_000_000)

    const bag = await tasks.Task.byId('local', task!.id)
    await bag.unlinkSession('session-to-unlink')

    expect((await taskSessions.taskSessions('local', task!.id))[task!.id]).toBeUndefined()
    const unlinked = (await bag.details()).events.filter((event) => event.kind === 'unlinked')
    expect(unlinked).toEqual([
      expect.objectContaining({
        targetKind: 'session',
        targetKey: 'session-to-unlink',
        targetTitle: 'Detached session',
        actor: 'user',
      }),
    ])

    // A second unlink is a no-op: no error, and no second history entry.
    await bag.unlinkSession('session-to-unlink')
    expect((await bag.details()).events.filter((event) => event.kind === 'unlinked')).toHaveLength(1)
  })

  test('the detail read carries no session links at all', async () => {
    // WHY: a task's attempts have exactly one reader, `taskSessions()`, whose
    // join is what gives every link its display metadata. A second copy on the
    // detail payload was written straight over the renderer's good links by
    // whichever surface opened first, renaming every session in the sidebar
    // after its parent task and every row in the task panel after its id.
    // Not "kept in sync" — absent, so the disagreement cannot be expressed.
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-detail',
      projectKey: '/workspace/solus',
      prompt: 'A task with one attempt',
    })

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
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'stable-session',
      projectKey: '/workspace/solus',
      prompt: 'A task with a stable session id',
    })
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
    const { readTaskSidebarSnapshot } = await import('@solus/server/tasks/task-sidebar')
    expect((await readTaskSidebarSnapshot('local')).sessionsByTask[task!.id][0].provider).toBe(provider)
  })

  test('performs no write for any dispatch with an existing provider session', async () => {
    // WHY: this structural gate keeps every pre-Phase-1 session outside the new
    // task system forever; follow-up prompts must not repair or backfill it.
    for (let prompt = 0; prompt < 3; prompt++) {
      expect(await taskSessions.prepareSessionTask('local', {
        existingAgentSessionId: 'provider-session-before-upgrade',
        sessionId: 'legacy-solus-session',
        projectKey: '/workspace/solus',
        prompt: `Follow-up ${prompt}`,
      })).toBeNull()
    }
    expect((await taskStore.listTasks('local')).tasks).toEqual([])
    expect(await taskSessions.tasksForSession('local', 'legacy-solus-session')).toBeNull()
  })

  test('generated session metadata names and describes its newly created task', async () => {
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-title',
      projectKey: '/workspace/solus',
      prompt: 'Raw first prompt',
    })
    expect(await taskSessions.updateGeneratedMetadataForSession('local', 
      'session-title',
      'Generated task title',
      'A generated task description.',
    )).toMatchObject({
      id: task!.id,
      title: 'Generated task title',
      titleSource: 'generated',
      body: 'A generated task description.',
    })

    await (await tasks.Task.byId('local', task!.id)).update({ title: 'Human title' })
    expect(await taskSessions.updateGeneratedMetadataForSession('local', 
      'session-title',
      'Late generated title',
      'Late generated description.',
    )).toBeNull()
    expect((await tasks.Task.byId('local', task!.id)).record()).toMatchObject({ title: 'Human title', titleSource: 'manual' })
  })

  test('generated metadata resolves a provider thread to its stable task session', async () => {
    // WHY: a new task is linked before the provider issues its thread id. The
    // later naming request carries that provider id, while the task link keeps
    // the stable Solus id used by every sidebar and handoff.
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'stable-session',
      prompt: 'Raw first prompt',
    })
    db.getDb().prepare(`
      INSERT INTO session_lineage_members(
        session_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
      ) VALUES (?, 0, ?, ?, ?, ?, NULL, ?)
    `).run('stable-session', 'codex', 'provider-session', '/workspace/solus', 1, 1)
    let changes = 0
    const unsubscribe = taskStore.onTasksChanged(() => changes++)
    try {
      expect(await taskSessions.updateGeneratedMetadataForSession('local', 
        'provider-session',
        'Generated task title',
        'A generated task description.',
      )).toMatchObject({
        id: task!.id,
        title: 'Generated task title',
        body: 'A generated task description.',
      })
      expect(changes).toBe(1)
    } finally {
      unsubscribe()
    }
  })

  test('generated metadata preserves a description edited while generation is in flight', async () => {
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-description-race',
      prompt: 'Raw first prompt',
    })
    await (await tasks.Task.byId('local', task!.id)).update({ body: 'Human-authored description' })

    expect(await taskSessions.updateGeneratedMetadataForSession('local', 
      'session-description-race',
      'Generated task title',
      'Generated description',
    )).toMatchObject({
      title: 'Generated task title',
      titleSource: 'generated',
      body: 'Human-authored description',
    })
    expect((await tasks.Task.byId('local', task!.id)).record()).toMatchObject({
      title: 'Generated task title',
      body: 'Human-authored description',
    })
  })

  test('generated metadata preserves a title edited while generation is in flight', async () => {
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'session-title-race',
      prompt: 'Raw first prompt',
    })
    await (await tasks.Task.byId('local', task!.id)).update({ title: 'Human-authored title' })

    expect(await taskSessions.updateGeneratedMetadataForSession('local', 
      'session-title-race',
      'Generated task title',
      'Generated description',
    )).toMatchObject({
      title: 'Human-authored title',
      titleSource: 'manual',
      body: 'Generated description',
    })
  })

  test('automatic metadata from a new linked session does not rename its parent task', async () => {
    // WHY: creating a subtask session can add another attempt link. Its generated
    // name belongs to that session or its own child task, not the existing parent.
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'origin-session',
      prompt: 'Original task title',
    })
    await (await tasks.Task.byId('local', task!.id)).linkSession('linked-session', 'working')

    expect(await taskSessions.updateGeneratedMetadataForSession('local', 
      'linked-session',
      'Linked session title',
      'Linked session description.',
    )).toBeNull()
    expect((await tasks.Task.byId('local', task!.id)).record()).toMatchObject({
      title: 'Original task title',
      titleSource: 'prompt',
      body: '',
    })
  })

  test('manual session rename does not rename a task shared by other sessions', async () => {
    // WHY: the sidebar can group several distinct attempts under one task. A
    // session rename belongs to one attempt and must not replace the shared
    // row's task title or make its sibling sessions appear to share a name.
    const task = await taskSessions.prepareSessionTask('local', {
      sessionId: 'first-session',
      prompt: 'Shared task title',
    })
    await (await tasks.Task.byId('local', task!.id)).linkSession('second-session', 'working')
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, first_message, custom_title, last_timestamp)
      VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
    `).run(
      'first-session', 'codex', 'First prompt', 'First session name', 1,
      'second-session', 'codex', 'Second prompt', 'Second session name', 2,
    )

    const { SolusServer } = await import('@solus/server/server/server')
    const { registerHistoryHandlers } = await import('@solus/server/server/handlers/history-handlers')
    const { HostEventPublisher } = await import('@solus/server/events/host-event-publisher')
    const { ClientEventRegistry } = await import('@solus/server/events/client-event-registry')
    const server = new SolusServer()
    // SAFETY: this test invokes only setSessionTitle, whose handler does not
    // read ControlPlane. The empty object prevents unrelated handler work.
    const controlPlane = {} as never
    registerHistoryHandlers(server, {
      controlPlane,
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
      existingTaskId: task.id,
      projectKey: '/workspace/solus',
      prompt: 'Work on existing task',
    })
    expect(bound).toMatchObject({
      projectKey: '/workspace/solus',
      status: 'in_progress',
    })
    const bag = await tasks.Task.byId('local', task.id)
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, message_count, size, branch)
      VALUES (?, 'codex', 0, ?, 0, 0, ?)
    `).run('bound-session', Date.now(), 'feature/bound')
    await bag.linkSession('bound-session', 'working', {
      originSessionId: 'provider-session',
    })
    await taskStore.database().run(sql`
      UPDATE ${(await import('@solus/server/tasks/schema')).taskSessionLinks}
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
      INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, message_count, size, branch)
      VALUES (?, 'claude', ?, ?, 0, 0, ?)
    `).run('clone-session', 0, Date.now(), 'feature/shared')
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, is_worktree, last_timestamp, message_count, size, branch)
      VALUES (?, 'claude', ?, ?, 0, 0, ?)
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
  test('a working link elsewhere moves the session and drops its empty placeholder', async () => {
    // WHY: a session's first dispatch mints a placeholder before the agent can
    // say which task the work belongs to. When it then links an existing task,
    // both rows used to survive and the sidebar drew the same conversation
    // under each. The store keeps one owner, so the untouched placeholder goes.
    const placeholder = await taskSessions.prepareSessionTask('local', {
      sessionId: 'moving-session',
      projectKey: '/workspace/solus',
      prompt: 'Investigate duplicate rows',
    })
    const existing = await taskStore.createTask('local', { title: 'Duplicate session sidebar entries' })

    await (await tasks.Task.byId('local', existing.id)).linkSession('moving-session', 'working')

    const links = await taskSessions.taskSessions('local')
    expect(links[existing.id]).toEqual([
      expect.objectContaining({ sessionId: 'moving-session', role: 'working' }),
    ])
    expect(links[placeholder!.id]).toBeUndefined()
    expect(await taskStore.loadTaskRecord('local', placeholder!.id)).toBeNull()
    expect(await taskSessions.tasksForSession('local', 'moving-session')).toMatchObject({
      task: { id: existing.id },
    })
  })

  test('a placeholder the agent wrote on outlives the transfer as a task of its own', async () => {
    // WHY: the agent addresses the placeholder by id during the turn. A comment
    // it left there is work, not scaffolding — only an untouched placeholder is
    // safe to drop. The session still moves; the task simply stays behind, empty
    // of sessions.
    const placeholder = await taskSessions.prepareSessionTask('local', {
      sessionId: 'commented-session',
      projectKey: '/workspace/solus',
      prompt: 'Placeholder with notes',
    })
    await (await tasks.Task.byId('local', placeholder!.id)).comment('Findings so far', { author: 'agent' })
    const existing = await taskStore.createTask('local', { title: 'Real task' })

    await (await tasks.Task.byId('local', existing.id)).linkSession('commented-session', 'working')

    expect(await taskStore.loadTaskRecord('local', placeholder!.id)).not.toBeNull()
    expect((await taskSessions.taskSessions('local'))[placeholder!.id]).toBeUndefined()
  })

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
    expect(firstDetails.events.map((event) => event.kind)).toContain('unlinked')
  })

  test('a referenced link neither moves the session nor outranks its owner', async () => {
    // WHY: referencing a session from a second task is a relationship, not a
    // move. The owner keeps answering for the session even though the reference
    // is the newer row — "latest link wins" is what used to hand it over.
    const owner = await taskStore.createTask('local', { title: 'Owner' })
    const referrer = await taskStore.createTask('local', { title: 'Referrer' })
    await (await tasks.Task.byId('local', owner.id)).linkSession('shared-session', 'working')
    await taskStore.database().run(sql`
      UPDATE ${(await import('@solus/server/tasks/schema')).taskSessionLinks} SET linked_at = 1 WHERE task_id = ${owner.id}
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
