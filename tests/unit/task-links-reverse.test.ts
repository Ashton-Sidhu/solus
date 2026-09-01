import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/tasks/task-store')
type TaskModule = typeof import('@solus/server/tasks/task')
type TaskLinksModule = typeof import('@solus/server/tasks/task-links')
type WorksModule = typeof import('@solus/server/folio/works')

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let taskLinks: TaskLinksModule
let works: WorksModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-links-reverse-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/tasks/task-store')
  tasks = await import('@solus/server/tasks/task')
  taskLinks = await import('@solus/server/tasks/task-links')
  works = await import('@solus/server/folio/works')
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

describe('which tasks link a target', () => {
  test('answers every task on the edge, with what a card needs to name it', async () => {
    // WHY: a conversation card says "Linked to T-184 · Fix sync" from this
    // read alone. It has to carry the task's title, status and short id, and
    // list every task on the edge — a document can belong to two.
    const work = await works.createWork('Latency report', 'artifact', '<html></html>', '', undefined, 'claude-code', '~')
    const first = await tasks.Task.byId((await taskStore.createTask({ title: 'Fix sync' })).id)
    const second = await tasks.Task.byId((await taskStore.createTask({ title: 'Ship it' })).id)
    await first.link({ kind: 'work', targetKey: work.id })
    await second.link({ kind: 'work', targetKey: work.id })
    await second.link({ kind: 'plan', targetScope: 'session-1', targetKey: 'plan-1', title: 'A plan' })

    const linked = taskLinks.readTasksLinkingTargets(db.getDb(), [
      { kind: 'work', targetScope: '', targetKey: work.id },
      { kind: 'plan', targetScope: 'session-1', targetKey: 'plan-1' },
      { kind: 'automation', targetScope: '', targetKey: 'nothing-links-this' },
    ])

    const forWork = linked.filter((edge) => edge.kind === 'work')
    expect(forWork.map((edge) => edge.taskId).sort()).toEqual([first.id, second.id].sort())
    expect(forWork.find((edge) => edge.taskId === first.id)).toMatchObject({
      title: 'Fix sync',
      status: 'inbox',
      targetKey: work.id,
    })
    expect(forWork.every((edge) => typeof edge.shortId === 'number')).toBe(true)
    expect(linked.filter((edge) => edge.kind === 'plan')).toEqual([
      expect.objectContaining({ taskId: second.id, targetScope: 'session-1', targetKey: 'plan-1' }),
    ])
    expect(linked.some((edge) => edge.kind === 'automation')).toBe(false)
  })

  test('an unlink drops the edge from the reverse read', async () => {
    // WHY: Unlink on the card is the reverse state; the next read must not
    // still say "Linked".
    const task = await tasks.Task.byId((await taskStore.createTask({ title: 'Fix sync' })).id)
    await task.link({ kind: 'automation', targetKey: 'auto-1', title: 'Nightly' })
    const target = { kind: 'automation' as const, targetScope: '', targetKey: 'auto-1' }
    expect(taskLinks.readTasksLinkingTargets(db.getDb(), [target])).toHaveLength(1)
    await task.unlink('automation', 'auto-1', '')
    expect(taskLinks.readTasksLinkingTargets(db.getDb(), [target])).toEqual([])
  })

  test('an empty ask makes no query', () => {
    expect(taskLinks.readTasksLinkingTargets(db.getDb(), [])).toEqual([])
  })
})
