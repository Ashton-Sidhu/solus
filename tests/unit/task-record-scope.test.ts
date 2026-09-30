import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'

/** The person every change in this file is made by. */
const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type DatabaseModule = typeof import('@solus/server/db/database')
type TaskStoreModule = typeof import('@solus/server/data/tasks/task-store')
type TaskModule = typeof import('@solus/server/data/tasks/task')
type PrincipalModule = typeof import('@solus/server/admission/principal')

let dataDir: string
let db: DbModule
let database: DatabaseModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let principal: PrincipalModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-record-scope-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  database = await import('@solus/server/db/database')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  principal = await import('@solus/server/admission/principal')
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

/**
 * A task row carries one canonical organization (organization-scope §3, R10).
 * A read names the scope the caller may see; a write to an existing task lands
 * in the organization stored on that task's row, never the caller's.
 */
describe('task record scope', () => {
  test('a read of every organization sees all tasks; a read of one sees its own', async () => {
    // WHY: the host owner reads their whole disk, while a member of A must not
    // see Local scratch or B's work through the same store.
    const local = await taskStore.createTask('local', { title: 'Scratch' })
    const organized = await taskStore.createTask('org-a', { title: 'Team work' })

    expect(local.organizationId).toBe('local')
    expect(organized.organizationId).toBe('org-a')

    const everything = (await taskStore.listTasks(principal.ANY_ORGANIZATION)).tasks.map((task) => task.id).sort()
    expect(everything).toEqual([local.id, organized.id].sort())
    expect((await taskStore.listTasks('org-a')).tasks.map((task) => task.id)).toEqual([organized.id])
    expect((await taskStore.listTasks('local')).tasks.map((task) => task.id)).toEqual([local.id])
  })

  test('a child row written through a wide scope inherits the task\'s organization', async () => {
    // WHY: the owner comments on A's task from a read of the whole disk. The
    // comment is A's, so A's members must find it under their own scope.
    const organized = await taskStore.createTask('org-a', { title: 'Team work' })
    const task = await tasks.Task.byId(principal.ANY_ORGANIZATION, organized.id)
    expect(task.organizationId).toBe('org-a')

    const details = await task.comment('Looks right', { by: BY })
    const commentId = details.comments[0]?.id
    expect(commentId).toBeDefined()

    const row = await database.getDatabase().get(sql`
      SELECT organization_id FROM task_comments WHERE id = ${commentId}
    `)
    expect(row).toEqual({ organization_id: 'org-a' })
    expect((await (await tasks.Task.byId('org-a', organized.id)).details()).comments).toHaveLength(1)
  })

  test('a task outside the scope is not found', async () => {
    // WHY: a member of B asking for A's task by id learns nothing, not even
    // that the id names a task.
    const organized = await taskStore.createTask('org-a', { title: 'Team work' })
    await expect(tasks.Task.byId('org-b', organized.id)).rejects.toThrow(`Task ${organized.id} not found.`)
    expect(await tasks.Task.forSession('org-b', 'no-session')).toBeNull()
  })
})
