import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Principal } from '@solus/server/admission/principal'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/data/tasks/task-store')
type TaskSnoozesModule = typeof import('@solus/server/data/tasks/task-snoozes')
type TaskModule = typeof import('@solus/server/data/tasks/task')
type SnoozeEventsModule = typeof import('@solus/server/transport/events/task-snooze-events')

const ORGANIZATION = 'org1'
const ALICE = 'alice'
const BOB = 'bob'
const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: ALICE }, displayName: 'Alice' } }

function member(userId: string, organizationId = ORGANIZATION): Principal {
  return { kind: 'org-member', userId, organizationId, organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: userId, deviceId: `${userId}-device`, expiresAt: 0, deviceLabel: 'Solus cloud' }
}

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let snoozes: TaskSnoozesModule
let tasks: TaskModule
let snoozeEvents: SnoozeEventsModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-snoozes-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/data/tasks/task-store')
  snoozes = await import('@solus/server/data/tasks/task-snoozes')
  tasks = await import('@solus/server/data/tasks/task')
  snoozeEvents = await import('@solus/server/transport/events/task-snooze-events')
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

describe('personal task snooze', () => {
  test("one person's snooze hides the task for them alone", async () => {
    // WHY: a shared task is everyone's work. Alice deferring it must not take it
    // out of Bob's list, or tell Bob that she did.
    const task = await taskStore.createTask(ORGANIZATION, { title: 'Shared work', status: 'in_progress' })
    const until = Date.now() + 3_600_000
    expect(await snoozes.snoozeTaskFor(ORGANIZATION, ALICE, task.id, until, '  after the release  '))
      .toEqual({ taskId: task.id, snoozedUntil: until, snoozeNote: 'after the release' })

    expect(await snoozes.readTaskSnoozes(ORGANIZATION, ALICE)).toEqual([{ taskId: task.id, snoozedUntil: until, snoozeNote: 'after the release' }])
    expect(await snoozes.readTaskSnoozes(ORGANIZATION, BOB)).toEqual([])
    // The shared record carries no snooze, so no list, event, or sync of the
    // task can show Alice's to anyone.
    const record = await taskStore.loadTaskRecord(ORGANIZATION, task.id)
    expect(record?.snoozedUntil).toBeUndefined()
    expect(record?.snoozeNote).toBeUndefined()

    const bobUntil = until + 60_000
    await snoozes.snoozeTaskFor(ORGANIZATION, BOB, task.id, bobUntil)
    expect(await snoozes.readTaskSnoozes(ORGANIZATION, ALICE)).toEqual([expect.objectContaining({ snoozedUntil: until })])
    expect(await snoozes.readTaskSnoozes(ORGANIZATION, BOB)).toEqual([{ taskId: task.id, snoozedUntil: bobUntil }])
  })

  test('a snooze leaves the task, its status, and its agents alone', async () => {
    // WHY: snooze is an attention control, not an execution control.
    const task = await taskStore.createTask(ORGANIZATION, { title: 'Running', status: 'in_progress' })
    const record = await tasks.Task.byId(ORGANIZATION, task.id)
    await record.linkSession('agent-at-work', 'working', {})
    const before = await (await tasks.Task.byId(ORGANIZATION, task.id)).details()

    await snoozes.snoozeTaskFor(ORGANIZATION, ALICE, task.id, Date.now() + 60_000)

    const after = await (await tasks.Task.byId(ORGANIZATION, task.id)).details()
    expect(after.task).toEqual(before.task)
    expect(after.activity).toEqual(before.activity)
    const { taskSessions } = await import('@solus/server/data/tasks/task-sessions')
    expect((await taskSessions(ORGANIZATION, task.id))[task.id]?.map((link) => link.sessionId)).toContain('agent-at-work')

    // A status change keeps the person's snooze: the two are independent.
    await (await tasks.Task.byId(ORGANIZATION, task.id)).update({ status: 'in_review' }, BY)
    expect(await snoozes.readTaskSnoozes(ORGANIZATION, ALICE)).toHaveLength(1)
  })

  test('a snooze survives a reconnect, outlives its wake time until woken, and wakes early', async () => {
    // WHY: the host holds the snooze, so a client that reconnects or restarts
    // reads it back. An ended snooze stays readable so the client can say the
    // task woke; waking it early removes it.
    const task = await taskStore.createTask(ORGANIZATION, { title: 'Later' })
    const ended = Date.now() - 60_000
    await snoozes.snoozeTaskFor(ORGANIZATION, ALICE, task.id, ended)
    expect(await snoozes.readTaskSnoozes(ORGANIZATION, ALICE)).toEqual([{ taskId: task.id, snoozedUntil: ended }])

    expect(await snoozes.snoozeTaskFor(ORGANIZATION, ALICE, task.id, null, 'ignored')).toBeNull()
    expect(await snoozes.readTaskSnoozes(ORGANIZATION, ALICE)).toEqual([])
  })

  test('a person can only snooze and read tasks in their scope', async () => {
    // WHY: a snooze must not let a person learn of, or write against, a task
    // in an organization they are not admitted to.
    const task = await taskStore.createTask(ORGANIZATION, { title: 'Org work' })
    await expect(snoozes.snoozeTaskFor('other-org', ALICE, task.id, Date.now() + 60_000)).rejects.toThrow()
    await snoozes.snoozeTaskFor(ORGANIZATION, ALICE, task.id, Date.now() + 60_000)
    expect(await snoozes.readTaskSnoozes('other-org', ALICE)).toEqual([])
  })

  test("a deleted task takes everyone's snoozes with it", async () => {
    // WHY: a snooze of a task that no longer exists would hide nothing and
    // never wake.
    const task = await taskStore.createTask(ORGANIZATION, { title: 'Gone soon' })
    await snoozes.snoozeTaskFor(ORGANIZATION, ALICE, task.id, Date.now() + 60_000)
    await (await tasks.Task.byId(ORGANIZATION, task.id)).delete()
    expect(await snoozes.readTaskSnoozes(ORGANIZATION, ALICE)).toEqual([])
  })
})

describe('task snooze events', () => {
  test("only the snoozing person's connections in that organization hear the change", () => {
    // WHY: the event must not tell anyone else that a task was snoozed.
    const principals: Record<string, Principal> = {
      'alice-desk': member(ALICE),
      'alice-phone': member(ALICE),
      'alice-elsewhere': member(ALICE, 'other-org'),
      'bob-desk': member(BOB),
    }
    const recipients = snoozeEvents.taskSnoozeRecipientClients(
      Object.keys(principals),
      (clientId) => principals[clientId],
      { personKey: ALICE, organizationId: ORGANIZATION },
    )
    expect(recipients.sort()).toEqual(['alice-desk', 'alice-phone'])
  })
})
