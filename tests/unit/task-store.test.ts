import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type MigrationsModule = typeof import('@solus/server/db/migrations')
type TaskStoreModule = typeof import('@solus/server/tasks/task-store')
type TaskModule = typeof import('@solus/server/tasks/task')
type TaskSessionsModule = typeof import('@solus/server/tasks/task-sessions')
type TaskLinksModule = typeof import('@solus/server/tasks/task-links')
type UlidModule = typeof import('@solus/server/tasks/ulid')

let dataDir: string
let db: DbModule
let migrations: MigrationsModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let taskSessions: TaskSessionsModule
let taskLinks: TaskLinksModule
let ids: UlidModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-store-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  migrations = await import('@solus/server/db/migrations')
  taskStore = await import('@solus/server/tasks/task-store')
  tasks = await import('@solus/server/tasks/task')
  taskSessions = await import('@solus/server/tasks/task-sessions')
  taskLinks = await import('@solus/server/tasks/task-links')
  ids = await import('@solus/server/tasks/ulid')
})

afterEach(() => {
  db.closeDb()
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

  test('the clean-slate entry discards legacy mirrored rows without backfilling them', () => {
    // WHY: old provider tasks and renderer-written bindings have different
    // ownership semantics; carrying them forward would fabricate task history.
    const legacy = new Database(':memory:')
    legacy.exec(`
      PRAGMA user_version = 7;
      CREATE TABLE sessions(session_id TEXT PRIMARY KEY, last_timestamp INTEGER);
      CREATE TABLE tasks(id TEXT PRIMARY KEY);
      INSERT INTO tasks VALUES ('legacy-task');
      CREATE TABLE task_session_links(task_id TEXT, session_id TEXT);
      INSERT INTO task_session_links VALUES ('legacy-task', 'legacy-session');
      CREATE TABLE task_cache(project_key TEXT, tasks TEXT);
      INSERT INTO task_cache VALUES ('legacy-project', '[]');
      CREATE TABLE pinned_sessions(
        session_id TEXT PRIMARY KEY,
        provider TEXT,
        title TEXT,
        cwd TEXT,
        pinned_at INTEGER
      );
    `)

    // SAFETY: Bun's in-memory Database implements the DatabaseSync methods the migration runner uses.
    migrations.runMigrations(legacy as never)

    expect(legacy.query('PRAGMA user_version').get()).toEqual({ user_version: 24 })
    expect(legacy.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
    expect(legacy.query('SELECT COUNT(*) AS count FROM task_session_links').get()).toEqual({ count: 0 })
    expect(legacy.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_cache'").get()).toBeNull()
    expect(legacy.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'upstream_task_cache'").get())
      .toEqual({ name: 'upstream_task_cache' })
    expect(legacy.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('task_comments', 'task_events', 'task_links') ORDER BY name").all())
      .toEqual([{ name: 'task_comments' }, { name: 'task_events' }, { name: 'task_links' }])
    expect(legacy.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_external_links'").get())
      .toEqual({ name: 'task_external_links' })
    // task_links is the generic linked-anything edge now, not the external-sync
    // mirror it briefly named.
    expect(legacy.query('SELECT name FROM pragma_table_info(?)').all('task_links').map((c: { name: string }) => c.name))
      .toContain('target_key')
    legacy.close()
  })

  test('migration folds provider task links into the stable session id', () => {
    // WHY: affected databases already contain both ids for one conversation.
    // Preventing the next duplicate is not enough; the upgrade must remove the
    // existing duplicate without losing its branch or first-link timestamp.
    const legacy = new Database(':memory:')
    legacy.exec(`
      PRAGMA user_version = 23;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        origin_session_id TEXT
      );
      CREATE TABLE task_session_links (
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        branch TEXT,
        pr TEXT,
        execution_server_id TEXT,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, session_id)
      );
      CREATE TABLE session_lineage_members (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        cwd TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, position)
      );
      INSERT INTO tasks VALUES ('task-1', 'provider-session');
      INSERT INTO session_lineage_members VALUES (
        'solus-session', 0, 'codex', 'provider-session', '/workspace/solus', 1, NULL, 1
      );
      INSERT INTO task_session_links VALUES (
        'task-1', 'solus-session', 'working', NULL, NULL, NULL, 20
      );
      INSERT INTO task_session_links VALUES (
        'task-1', 'provider-session', 'working', 'fix/duplicate', NULL, NULL, 10
      );
    `)

    // SAFETY: Bun's in-memory Database implements the DatabaseSync methods the migration runner uses.
    migrations.runMigrations(legacy as never)

    expect(legacy.query(`
      SELECT task_id, session_id, branch, linked_at
      FROM task_session_links
    `).all()).toEqual([{
      task_id: 'task-1',
      session_id: 'solus-session',
      branch: 'fix/duplicate',
      linked_at: 10,
    }])
    expect(legacy.query('SELECT origin_session_id FROM tasks').get()).toEqual({
      origin_session_id: 'solus-session',
    })
    expect(legacy.query('PRAGMA user_version').get()).toEqual({ user_version: 24 })
    legacy.close()
  })
})

describe('native task CRUD', () => {
  test('lists more than 99 tasks without truncation', async () => {
    // WHY: the global task picker consumes this complete native snapshot. A
    // hidden two-digit boundary would make older work impossible to search.
    const creations = Array.from({ length: 105 }, (_, index) =>
      taskStore.createTask({
        title: `Searchable task ${index + 1}`,
        projectKey: '/workspace/solus',
      }),
    )
    await Promise.all(creations)

    expect((await taskStore.listTasks()).tasks).toHaveLength(105)
  })

  test('restores a number-only PR link for the sidebar after restart', async () => {
    // WHY: agent link_task calls can identify a PR by number without a URL.
    // The durable edge, not the renderer PR list, must restore the chip.
    const task = await taskStore.createTask({
      title: 'Keep linked PR visible',
      projectKey: '/workspace/solus',
    })
    await (await tasks.Task.byId(task.id)).link({
      kind: 'pr',
      targetScope: '/workspace/solus',
      targetKey: '43',
      createdBy: 'agent',
    })

    expect(taskLinks.readLatestTaskPrLinks(db.getDb())).toEqual({
      [task.id]: { number: 43 },
    })
  })

  test('publishes a session-born task only after its provider session is linked', async () => {
    // WHY: a pre-launch task without a session link appears beside the loose
    // renderer session as a duplicate row until session_init links the two.
    let changes = 0
    const unsubscribe = taskStore.onTasksChanged(() => changes++)
    try {
      const task = await taskSessions.prepareSessionTask({
        projectKey: '/workspace/solus',
        prompt: 'Start one coherent task row',
      })

      expect(task).not.toBeNull()
      expect(changes).toBe(0)

      await (await tasks.Task.byId(task!.id)).linkSession('provider-session', 'working')

      expect(changes).toBe(1)
      expect(await taskSessions.tasksForSession('provider-session')).toMatchObject({
        task: { id: task!.id },
      })
    } finally {
      unsubscribe()
    }
  })

  test('files a worktree session under its base project', async () => {
    // WHY: conflict-resolution sessions execute in a managed PR worktree, but
    // the project-scoped sidebar must still include their task row.
    const task = await taskSessions.prepareSessionTask({
      projectKey: '/workspace/solus/.solus-worktrees/pr-47',
      worktreeKey: '/workspace/solus::solus/pr-47 (worktree)',
      prompt: 'Resolve the PR conflicts',
    })

    expect(task).toMatchObject({
      projectKey: '/workspace/solus',
      worktreeKey: '/workspace/solus::solus/pr-47 (worktree)',
    })
  })

  test('stores the six-state lifecycle and global inbox independently of project paths', async () => {
    // WHY: projectKey is a logical path used by history/sidebar grouping; it is
    // opaque store data and NULL, not a legacy hash, is the global inbox.
    const inbox = await taskStore.createTask({ title: 'Triage this later' })
    const project = await taskStore.createTask({
      title: 'Ready work',
      projectKey: '/workspace/solus',
      status: 'todo',
      labels: ['backend'],
    })

    expect(inbox).toMatchObject({ projectKey: null, status: 'inbox', titleSource: 'manual', source: 'user' })
    expect(project).toMatchObject({ projectKey: '/workspace/solus', status: 'todo', labels: ['backend'] })
    expect(inbox.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(project.shortId).toBe((inbox.shortId ?? 0) + 1)
    expect((await taskStore.listTasks({ scope: 'inbox' })).tasks.map((task) => task.id)).toEqual([inbox.id])

    for (const status of ['in_progress', 'in_review', 'done', 'dropped', 'todo', 'inbox'] as const) {
      const updated = await (await tasks.Task.byId(project.id)).update({
        status,
        projectKey: status === 'inbox' ? null : '/workspace/solus',
      })
      expect(updated.status).toBe(status)
      if (status === 'done') expect(updated.doneAt).toEqual(expect.any(Number))
      else expect(updated.doneAt).toBeUndefined()
    }

    const detailed = await (await tasks.Task.byId(inbox.id)).comment('Local finding', {
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

    const inboxTask = await tasks.Task.byId(inbox.id)
    expect(await inboxTask.delete()).toBe(true)
    expect(await inboxTask.delete()).toBe(false)
  })

  test('cascades subtask deletion and rejects a third hierarchy level', async () => {
    const parent = await taskStore.createTask({ title: 'Parent', projectKey: '/workspace/solus' })
    const child = await taskStore.createTask({ title: 'Child', parentId: parent.id })

    await expect(taskStore.createTask({ title: 'Grandchild', parentId: child.id })).rejects.toThrow(
      'Subtasks cannot contain nested subtasks.',
    )
    expect((await (await tasks.Task.byId(parent.id)).details()).subtasks.map((task) => task.id)).toEqual([child.id])
    expect(await (await tasks.Task.byId(parent.id)).delete()).toBe(true)
    expect((await taskStore.listTasks()).tasks).toEqual([])
  })
})

describe('session minting and durable links', () => {
  test('exposes typed task methods for every workspace link kind', async () => {
    // WHY: callers should express domain identity (`workId`, plan pair,
    // `automationId`) instead of constructing task_links storage keys.
    const task = await taskStore.createTask({ title: 'Collect task context' })
    const instance = await tasks.Task.byId(task.id)

    await instance.linkWork('work-1', { title: 'Architecture notes' })
    await instance.linkPlan('session-plan', 'tool-plan', { title: 'Implementation plan' })
    const details = await instance.linkAutomation('automation-1', { title: 'Nightly verification' })

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
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'session-with-pr',
      projectKey: '/workspace/solus',
      prompt: 'Open the pull request',
      branch: 'feature/task-pr',
    })

    const pullRequest = {
      number: 321,
      title: '#321 Attach session PRs',
      url: 'https://github.com/acme/solus/pull/321',
      targetScope: '/workspace/solus',
    }
    const taskInstance = await tasks.Task.forSession('session-with-pr')
    expect(taskInstance?.id).toBe(task!.id)
    await taskInstance!.linkPullRequest({
      ...pullRequest,
      originSessionId: 'session-with-pr',
      createdBy: 'agent',
    })
    await taskInstance!.linkPullRequest({
      ...pullRequest,
      originSessionId: 'session-with-pr',
      createdBy: 'agent',
    })

    const details = await (await tasks.Task.byId(task!.id)).details()
    expect(details.task.pr).toEqual({ number: 321, url: pullRequest.url })
    expect(details.links).toEqual([
      expect.objectContaining({
        kind: 'pr',
        targetScope: '/workspace/solus',
        targetKey: '321',
        title: '#321 Attach session PRs',
        url: pullRequest.url,
        createdBy: 'agent',
        originSessionId: 'session-with-pr',
      }),
    ])
    expect(details.events.filter((event) => event.kind === 'linked')).toHaveLength(1)
    expect((await taskSessions.taskSessions(task!.id))[task!.id][0].pr).toEqual({
      number: 321,
      url: pullRequest.url,
    })
  })

  test('links session artifacts to the owning task exactly once', async () => {
    // WHY: artifacts created or edited by an agent must remain discoverable
    // from its task without repeated edits producing duplicate activity.
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'session-with-artifacts',
      projectKey: '/workspace/solus',
      prompt: 'Create the task artifacts',
    })

    const link = {
      kind: 'work' as const,
      targetKey: 'work-from-session',
      title: 'Session notes',
    }
    await tasks.Task.linkArtifactForSession('session-with-artifacts', link)
    await tasks.Task.linkArtifactForSession('session-with-artifacts', link)

    const details = await (await tasks.Task.byId(task!.id)).details()
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
    const root = await taskSessions.prepareSessionTask({
      sessionId: 'session-root',
      projectKey: '/workspace/solus',
      worktreeKey: 'feature/tasks',
      prompt: '\n  Build the durable tasks foundation with an intentionally very long suffix that is clipped\nMore',
      branch: 'feature/tasks',
    })
    const child = await taskSessions.prepareSessionTask({
      sessionId: 'session-child',
      projectKey: '/workspace/solus',
      worktreeKey: 'feature/tasks',
      prompt: 'Add focused tests',
    })
    const sibling = await taskSessions.prepareSessionTask({
      sessionId: 'session-sibling',
      projectKey: '/workspace/solus',
      worktreeKey: 'feature/tasks',
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
    expect((await taskSessions.taskSessions())[root!.id]).toEqual([
      expect.objectContaining({ sessionId: 'session-root', role: 'working', branch: 'feature/tasks' }),
    ])
    expect((await taskSessions.tasksForSession('session-child'))).toMatchObject({
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
    const root = await taskStore.createTask({
      title: 'The task on screen',
      projectKey: '/workspace/solus',
    })

    await taskSessions.prepareSessionTask({
      existingTaskId: root.id,
      sessionId: 'session-first-attempt',
      projectKey: '/workspace/solus',
      prompt: 'Try the first approach',
    })
    await taskSessions.prepareSessionTask({
      existingTaskId: root.id,
      sessionId: 'session-second-attempt',
      projectKey: '/workspace/solus',
      prompt: 'Try a different approach',
    })

    const tasks = (await taskStore.listTasks()).tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe(root.id)
    expect(tasks[0].parentId).toBeUndefined()
    expect((await taskSessions.taskSessions(root.id))[root.id]).toEqual([
      expect.objectContaining({ taskId: root.id, sessionId: 'session-first-attempt' }),
      expect.objectContaining({ taskId: root.id, sessionId: 'session-second-attempt' }),
    ])
  })

  test('can mint a session-born subtask beneath an explicit parent', async () => {
    // WHY: agent-created worker sessions must carry task hierarchy at first
    // dispatch so their initial system prompt already names the parent and
    // sibling work instead of relying on a racy follow-up link.
    const parent = await taskStore.createTask({
      title: 'Ship task-aware tools',
      projectKey: '/workspace/solus',
    })

    const child = await taskSessions.prepareSessionTask({
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
    expect(await taskSessions.tasksForSession('session-child-worker')).toMatchObject({
      task: { id: child!.id, parentId: parent.id },
      parent: { id: parent.id },
    })
  })

  test('task session links include indexed session title and activity', async () => {
    // WHY: closed attempts have no mounted renderer session, so the sidebar
    // needs their persisted display metadata on the durable task link.
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'session-with-metadata',
      projectKey: '/workspace/solus',
      prompt: 'Raw session prompt',
    })
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, first_message, custom_title, last_timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-with-metadata', 'codex', 'First session message', 'Named session', 1_725_000_000_000)

    expect((await taskSessions.taskSessions(task!.id))[task!.id]).toEqual([
      expect.objectContaining({
        sessionId: 'session-with-metadata',
        sessionTitle: 'Named session',
        lastActivityAt: 1_725_000_000_000,
      }),
    ])
    expect((await taskSessions.tasksForSession('session-with-metadata'))?.attempts).toEqual([
      expect.objectContaining({
        sessionId: 'session-with-metadata',
        sessionTitle: 'Named session',
        lastActivityAt: 1_725_000_000_000,
      }),
    ])
  })

  test('unlinking a session removes the attempt and records who detached what', async () => {
    // WHY: linking a session has always had no way out. Unlink must remove
    // exactly one attempt row, keep the activity feed able to say which
    // session left by name, and stay silent when there is nothing to remove.
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'session-to-unlink',
      projectKey: '/workspace/solus',
      prompt: 'Attempt that gets detached',
    })
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, first_message, custom_title, last_timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-to-unlink', 'claude-code', 'First message', 'Detached session', 1_725_000_000_000)

    const bag = await tasks.Task.byId(task!.id)
    await bag.unlinkSession('session-to-unlink')

    expect((await taskSessions.taskSessions(task!.id))[task!.id]).toBeUndefined()
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
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'session-detail',
      projectKey: '/workspace/solus',
      prompt: 'A task with one attempt',
    })

    const details = await (await tasks.Task.byId(task!.id)).details()
    expect(details).not.toHaveProperty('attempts')
    expect((await taskSessions.taskSessions(task!.id))[task!.id]).toHaveLength(1)
  })

  test('task attempts read session metadata through the stable lineage id', async () => {
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'stable-session',
      projectKey: '/workspace/solus',
      prompt: 'A task with a stable session id',
    })
    db.getDb().prepare(`
      INSERT INTO sessions(session_id, provider, first_message, custom_title, last_timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run('provider-session', 'codex', 'First provider message', 'Provider session title', 1_725_000_000_000)
    db.getDb().prepare(`
      INSERT INTO session_lineage_members(
        session_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('stable-session', 0, 'codex', 'provider-session', '/workspace/solus', 1, null, 1)

    expect((await taskSessions.taskSessions(task!.id))[task!.id]).toEqual([
      expect.objectContaining({
        sessionId: 'stable-session',
        sessionTitle: 'Provider session title',
        provider: 'codex',
      }),
    ])
  })

  test('performs no write for any dispatch with an existing provider session', async () => {
    // WHY: this structural gate keeps every pre-Phase-1 session outside the new
    // task system forever; follow-up prompts must not repair or backfill it.
    for (let prompt = 0; prompt < 3; prompt++) {
      expect(await taskSessions.prepareSessionTask({
        existingAgentSessionId: 'provider-session-before-upgrade',
        sessionId: 'legacy-solus-session',
        projectKey: '/workspace/solus',
        worktreeKey: 'main',
        prompt: `Follow-up ${prompt}`,
      })).toBeNull()
    }
    expect((await taskStore.listTasks()).tasks).toEqual([])
    expect(await taskSessions.tasksForSession('legacy-solus-session')).toBeNull()
  })

  test('generated session metadata names and describes its newly created task', async () => {
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'session-title',
      projectKey: '/workspace/solus',
      worktreeKey: 'title-work',
      prompt: 'Raw first prompt',
    })
    expect(await taskSessions.updateGeneratedMetadataForSession(
      'session-title',
      'Generated task title',
      'A generated task description.',
    )).toMatchObject({
      id: task!.id,
      title: 'Generated task title',
      titleSource: 'generated',
      body: 'A generated task description.',
    })

    await (await tasks.Task.byId(task!.id)).update({ title: 'Human title' })
    expect(await taskSessions.updateGeneratedMetadataForSession(
      'session-title',
      'Late generated title',
      'Late generated description.',
    )).toBeNull()
    expect((await tasks.Task.byId(task!.id)).record()).toMatchObject({ title: 'Human title', titleSource: 'manual' })
  })

  test('generated metadata resolves a provider thread to its stable task session', async () => {
    // WHY: a new task is linked before the provider issues its thread id. The
    // later naming request carries that provider id, while the task link keeps
    // the stable Solus id used by every sidebar and handoff.
    const task = await taskSessions.prepareSessionTask({
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
      expect(await taskSessions.updateGeneratedMetadataForSession(
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
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'session-description-race',
      prompt: 'Raw first prompt',
    })
    await (await tasks.Task.byId(task!.id)).update({ body: 'Human-authored description' })

    expect(await taskSessions.updateGeneratedMetadataForSession(
      'session-description-race',
      'Generated task title',
      'Generated description',
    )).toMatchObject({
      title: 'Generated task title',
      titleSource: 'generated',
      body: 'Human-authored description',
    })
    expect((await tasks.Task.byId(task!.id)).record()).toMatchObject({
      title: 'Generated task title',
      body: 'Human-authored description',
    })
  })

  test('generated metadata preserves a title edited while generation is in flight', async () => {
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'session-title-race',
      prompt: 'Raw first prompt',
    })
    await (await tasks.Task.byId(task!.id)).update({ title: 'Human-authored title' })

    expect(await taskSessions.updateGeneratedMetadataForSession(
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
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'origin-session',
      prompt: 'Original task title',
    })
    await (await tasks.Task.byId(task!.id)).linkSession('linked-session', 'working')

    expect(await taskSessions.updateGeneratedMetadataForSession(
      'linked-session',
      'Linked session title',
      'Linked session description.',
    )).toBeNull()
    expect((await tasks.Task.byId(task!.id)).record()).toMatchObject({
      title: 'Original task title',
      titleSource: 'prompt',
      body: '',
    })
  })

  test('manual session rename does not rename a task shared by other sessions', async () => {
    // WHY: the sidebar can group several distinct attempts under one task. A
    // session rename belongs to one attempt and must not replace the shared
    // row's task title or make its sibling sessions appear to share a name.
    const task = await taskSessions.prepareSessionTask({
      sessionId: 'first-session',
      prompt: 'Shared task title',
    })
    await (await tasks.Task.byId(task!.id)).linkSession('second-session', 'working')
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

    await server.handle('setSessionTitle', ['second-session', 'Renamed second session', 'manual'])

    expect((await tasks.Task.byId(task!.id)).record()).toMatchObject({
      title: 'Shared task title',
    })
    expect((await taskSessions.taskSessions(task!.id))[task!.id].map((link) => link.sessionTitle))
      .toEqual(['First session name', 'Renamed second session'])
  })

  test('explicit binding stamps provenance on the attempt', async () => {
    const task = await taskStore.createTask({ title: 'Existing task' })
    const bound = await taskSessions.prepareSessionTask({
      existingTaskId: task.id,
      projectKey: '/workspace/solus',
      worktreeKey: '/workspace/solus::feature/bound (worktree)',
      prompt: 'Work on existing task',
    })
    expect(bound).toMatchObject({
      projectKey: '/workspace/solus',
      worktreeKey: '/workspace/solus::feature/bound (worktree)',
      status: 'in_progress',
    })
    const bag = await tasks.Task.byId(task.id)
    await bag.linkSession('bound-session', 'working', {
      branch: 'feature/bound',
      originSessionId: 'provider-session',
    })
    // Re-linking is bookkeeping: captured branch and provenance stay first-write-wins.
    await bag.linkSession('bound-session', 'working', {})

    const detail = await bag.details()
    expect(detail.task).toMatchObject({
      branch: 'feature/bound',
      originSessionId: 'provider-session',
    })
    expect((await taskSessions.taskSessions(task.id))[task.id]).toEqual([
      expect.objectContaining({ sessionId: 'bound-session', branch: 'feature/bound' }),
    ])
  })

  test('a dispatched attempt remembers the host it ran on', async () => {
    const task = await taskStore.createTask({ title: 'Dispatched task' })
    const bag = await tasks.Task.byId(task.id)
    // The client is the only party that can name the execution host — this host
    // is the task's, and it never sees the agent. Without that the attempt is
    // indistinguishable from one that ran here, and every closed-session row
    // reads as local.
    await bag.linkSession('dispatched-session', 'working', {
      execution: { serverId: 'studio', provider: 'claude', projectRoot: '/repo' },
    })
    await bag.linkSession('local-session', 'working', { execution: null })
    // Re-linking carries no host — it must not erase the one already recorded.
    await bag.linkSession('dispatched-session', 'working', {})

    // Keyed rather than ordered: re-linking refreshes `linked_at`, so the list
    // order is about recency and says nothing about the host.
    const hostBySession = Object.fromEntries(
      (await taskSessions.taskSessions(task.id))[task.id].map(
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
    const first = await taskStore.createTask({ title: 'Dispatched task' })
    const second = await taskStore.createTask({ title: 'Task that references it' })
    await (await tasks.Task.byId(first.id)).linkSession('shared-session', 'working', {
      execution: { serverId: 'studio', provider: 'claude', projectRoot: '/repo' },
    })
    await (await tasks.Task.byId(second.id)).linkSession('shared-session', 'referenced')

    const links = await taskSessions.taskSessions()
    expect(links[second.id]).toEqual([
      expect.objectContaining({ sessionId: 'shared-session', executionServerId: 'studio' }),
    ])
    // The stub session row also carries the agent, so the task's host can name
    // it without ever holding the transcript.
    expect(links[first.id][0].provider).toBe('claude')
  })
})
