import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/tasks/task-store')
type TaskLifecycleModule = typeof import('@solus/server/tasks/task-lifecycle')
type TaskEventsModule = typeof import('@solus/server/tasks/task-events')
type TaskModule = typeof import('@solus/server/tasks/task')

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let lifecycle: TaskLifecycleModule
let taskEvents: TaskEventsModule
let tasks: TaskModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-lifecycle-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/tasks/task-store')
  lifecycle = await import('@solus/server/tasks/task-lifecycle')
  taskEvents = await import('@solus/server/tasks/task-events')
  tasks = await import('@solus/server/tasks/task')
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

describe('task sidebar lifecycle', () => {
  test('completion and reopening use the canonical task status', async () => {
    // WHY: the sidebar must not invent a second lifecycle beside TaskStatus.
    const task = await taskStore.createTask({ title: 'Review later', status: 'in_review' })
    const completed = await (await tasks.Task.byId(task.id)).update({ status: 'done' })
    expect(completed.record()).toMatchObject({ status: 'done', doneAt: expect.any(Number) })

    const reopened = await completed.update({ status: 'todo' })
    expect(reopened.record().status).toBe('todo')
    expect(reopened.record().doneAt).toBeUndefined()
  })

  test('stores a local reminder and preserves it when the task wakes', async () => {
    // WHY: Wake now stamps the due time into the past so the task returns to
    // active while the reminder can still back the divider and tooltip.
    const task = await taskStore.createTask({ title: 'Check the deployment' })
    const until = Date.now() + 60_000
    const snoozed = await lifecycle.snoozeTask(task.id, {
      until,
      note: 'Confirm the canary error rate',
    })

    expect(snoozed).toMatchObject({
      snoozedUntil: until,
      snoozedAt: expect.any(Number),
      snoozeNote: 'Confirm the canary error rate',
    })
    expect(await lifecycle.snoozeTask(task.id, { until: null })).toMatchObject({
      snoozedUntil: expect.any(Number),
      snoozeNote: 'Confirm the canary error rate',
    })
  })

  test('rejects expired snoozes and records the reminder in task activity', async () => {
    const task = await taskStore.createTask({ title: 'Follow up' })
    await expect(lifecycle.snoozeTask(task.id, { until: Date.now() - 1 })).rejects.toThrow(
      'future',
    )
    await lifecycle.snoozeTask(task.id, {
      until: Date.now() + 60_000,
      note: 'Ask for the missing trace',
    })

    expect(taskEvents.readTaskEvents(taskStore.database(), task.id).find((event) => event.kind === 'snoozed')).toMatchObject({
      kind: 'snoozed',
      targetTitle: 'Ask for the missing trace',
    })
  })

  test('read state changes without becoming task activity', async () => {
    // WHY: visiting a conversation must not reorder the task as if new work happened.
    const task = await taskStore.createTask({ title: 'Read state' })
    const updatedAt = task.updatedAt
    const read = await lifecycle.markTaskRead(task.id, true)
    expect(read.lastReadAt).toEqual(expect.any(Number))
    expect(read.updatedAt).toBe(updatedAt)
    expect((await lifecycle.markTaskRead(task.id, false)).lastReadAt).toBeUndefined()
  })

  test('meaningful activity wakes snoozes without changing workflow status', async () => {
    const task = await taskStore.createTask({ title: 'Wake on work' })
    await lifecycle.snoozeTask(task.id, { until: Date.now() + 60_000, note: 'Come back' })
    await (await tasks.Task.byId(task.id)).update({ body: 'New work arrived' })
    expect(taskStore.loadTaskRecord(task.id)).toMatchObject({ body: 'New work arrived', status: task.status })
    expect(taskStore.loadTaskRecord(task.id)?.snoozedUntil).toBeUndefined()
  })

  test('a linked conversation prompt wakes a snoozed task', async () => {
    // WHY: follow-up prompts do not otherwise write the task record, but they
    // are meaningful activity and must bring a snoozed task back.
    const task = await taskStore.createTask({ title: 'Continue in conversation' })
    await lifecycle.snoozeTask(task.id, { until: Date.now() + 60_000 })
    expect((await lifecycle.recordTaskActivity(task.id)).snoozedUntil).toBeUndefined()
  })

  test('a linked conversation prompt reopens completed and dropped tasks', async () => {
    // WHY: typing another turn means work resumed. The agent must not need to
    // repair the task status before it can continue the user's request.
    for (const status of ['done', 'dropped'] as const) {
      const task = await taskStore.createTask({ title: `Resume ${status}`, status })
      const active = await lifecycle.recordTaskActivity(task.id)

      expect(active.status).toBe('in_progress')
      expect(active.doneAt).toBeUndefined()
      expect(taskEvents.readTaskEvents(taskStore.database(), task.id)).toContainEqual(
        expect.objectContaining({
          kind: 'status_changed',
          from: status,
          to: 'in_progress',
          actor: 'user',
        }),
      )
    }
  })

  test('a linked conversation prompt keeps an open task in its current status', async () => {
    const task = await taskStore.createTask({ title: 'Keep review state', status: 'in_review' })

    expect((await lifecycle.recordTaskActivity(task.id)).status).toBe('in_review')
  })

  test('completed tasks must be reopened before snoozing', async () => {
    const task = await taskStore.createTask({ title: 'Finished work', status: 'done' })
    await expect(lifecycle.snoozeTask(task.id, { until: Date.now() + 60_000 })).rejects.toThrow(
      'reopened',
    )
  })
})
