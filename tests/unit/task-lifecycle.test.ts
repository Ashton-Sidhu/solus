import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

/** The person every change in this file is made by. */
const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/data/tasks/task-store')
type TaskLifecycleModule = typeof import('@solus/server/data/tasks/task-lifecycle')
type TaskModule = typeof import('@solus/server/data/tasks/task')

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let lifecycle: TaskLifecycleModule
let tasks: TaskModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-lifecycle-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/data/tasks/task-store')
  lifecycle = await import('@solus/server/data/tasks/task-lifecycle')
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

describe('task sidebar lifecycle', () => {
  test('completion and reopening use the canonical task status', async () => {
    // WHY: the sidebar must not invent a second lifecycle beside TaskStatus.
    const task = await taskStore.createTask('local', { title: 'Review later', status: 'in_review' })
    const completed = await (await tasks.Task.byId('local', task.id)).update({ status: 'done' }, BY)
    expect(completed.record()).toMatchObject({ status: 'done', doneAt: expect.any(Number) })

    const reopened = await completed.update({ status: 'todo' }, BY)
    expect(reopened.record().status).toBe('todo')
    expect(reopened.record().doneAt).toBeUndefined()
  })

  test('read state changes without becoming task activity', async () => {
    // WHY: visiting a conversation must not reorder the task as if new work happened.
    const task = await taskStore.createTask('local', { title: 'Read state' })
    const updatedAt = task.updatedAt
    const read = await lifecycle.markTaskRead('local', task.id, true)
    expect(read.lastReadAt).toEqual(expect.any(Number))
    expect(read.updatedAt).toBe(updatedAt)
    expect((await lifecycle.markTaskRead('local', task.id, false)).lastReadAt).toBeUndefined()
  })

  test('a linked conversation prompt reopens completed and dropped tasks', async () => {
    // WHY: typing another turn means work resumed. The agent must not need to
    // repair the task status before it can continue the user's request.
    for (const status of ['done', 'dropped'] as const) {
      const task = await taskStore.createTask('local', { title: `Resume ${status}`, status })
      const active = await lifecycle.recordTaskActivity('local', task.id, BY)

      expect(active.status).toBe('in_progress')
      expect(active.doneAt).toBeUndefined()
      expect((await (await tasks.Task.byId('local', task.id)).details()).activity).toContainEqual(
        expect.objectContaining({
          kind: 'task_changed',
          change: 'status_changed',
          from: status,
          to: 'in_progress',
          by: BY,
        }),
      )
    }
  })

  test('a linked conversation prompt keeps an open task in its current status', async () => {
    const task = await taskStore.createTask('local', { title: 'Keep review state', status: 'in_review' })

    expect((await lifecycle.recordTaskActivity('local', task.id, BY)).status).toBe('in_review')
  })
})

describe('task change announcements', () => {
  // WHY: each announcement makes every client re-read tasks. The whole list is
  // over a megabyte at a thousand tasks, so a write that touched one task must
  // name it, and a write that changed nothing must not announce at all.
  async function announced(write: () => Promise<unknown>): Promise<Array<string | undefined>> {
    const taskIds: Array<string | undefined> = []
    const stop = taskStore.onTasksChanged((taskId) => taskIds.push(taskId))
    try {
      await write()
    } finally {
      stop()
    }
    return taskIds
  }

  test('a single-task write names its task; a delete names none', async () => {
    const task = await taskStore.createTask('local', { title: 'Named' })
    const model = await tasks.Task.byId('local', task.id)

    expect(await announced(() => model.update({ title: 'Renamed' }, BY))).toEqual([task.id])
    // A deleted row cannot be read back, so clients read the whole list.
    expect(await announced(() => model.delete())).toEqual([undefined])
  })

  test('activity on an open task announces nothing; a reopen names the task', async () => {
    const open = await taskStore.createTask('local', { title: 'Open', status: 'in_progress' })
    const done = await taskStore.createTask('local', { title: 'Done', status: 'done' })

    expect(await announced(() => lifecycle.recordTaskActivity('local', open.id, BY))).toEqual([])
    expect(await announced(() => lifecycle.recordTaskActivity('local', done.id, BY))).toEqual([done.id])
  })

  test('a session rename names only the tasks linked to that session', async () => {
    const { emitSessionTasksChanged } = await import('@solus/server/data/tasks/task-sessions')
    const linked = await taskStore.createTask('local', { title: 'Linked' })
    await taskStore.createTask('local', { title: 'Unrelated' })
    await (await tasks.Task.byId('local', linked.id)).linkSession('renamed-session')

    expect(await announced(() => emitSessionTasksChanged('local', 'renamed-session'))).toEqual([linked.id])
    expect(await announced(() => emitSessionTasksChanged('local', 'taskless-session'))).toEqual([])
  })

  test('a pull request observation names only the tasks that link it', async () => {
    // WHY: opening a pull request page re-read it and announced a change to
    // every task; each read then cost every client a whole-list reload.
    const { emitPullRequestTasksChanged } = await import('@solus/server/data/tasks/task-links')
    const linked = await taskStore.createTask('local', { title: 'Ships the PR' })
    await taskStore.createTask('local', { title: 'Unrelated' })
    await (await tasks.Task.byId('local', linked.id)).linkPullRequest({
      number: 42, url: 'https://github.com/Acme/App/pull/42', title: 'Fix', targetScope: 'github.com/Acme/App',
    }, BY)

    // Repository keys arrive in either case: from a remote URL and from a task link.
    expect(await announced(() => emitPullRequestTasksChanged('local', 'github.com/acme/app', 42))).toEqual([linked.id])
    expect(await announced(() => emitPullRequestTasksChanged('local', 'github.com/acme/app', 43))).toEqual([])
  })

  test('a narrowed sidebar read returns only the named tasks and their attempts', async () => {
    const { readTaskSidebarSnapshot } = await import('@solus/server/data/tasks/task-sidebar')
    const wanted = await taskStore.createTask('local', { title: 'Wanted' })
    const other = await taskStore.createTask('local', { title: 'Other' })
    await (await tasks.Task.byId('local', wanted.id)).linkSession('wanted-session')
    await (await tasks.Task.byId('local', other.id)).linkSession('other-session')

    const narrowed = await readTaskSidebarSnapshot('local', [wanted.id, 'missing-task'])
    expect(narrowed.tasks.map((task) => task.id)).toEqual([wanted.id])
    expect(Object.keys(narrowed.sessionsByTask)).toEqual([wanted.id])
    expect((await readTaskSidebarSnapshot('local', [])).tasks).toEqual([])
    expect((await readTaskSidebarSnapshot('local')).tasks).toHaveLength(2)
  })
})
