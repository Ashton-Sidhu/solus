import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskSnapshot } from '../../src/shared/task-types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let createTask: typeof import('../../src/main/tasks/task-store')['createTask']
let TaskModule: typeof import('../../src/main/tasks/task')
let outbox: typeof import('../../src/main/outbox/outbox-store')
let foreignTasks: typeof import('../../src/main/tasks/foreign-tasks')
let taskApplier: typeof import('../../src/main/tasks/task-applier')
let taskTools: typeof import('../../src/main/tasks/task-tools')
let closeDb: typeof import('../../src/main/db')['closeDb']

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-dispatch-parity-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ createTask } = await import('../../src/main/tasks/task-store'))
  TaskModule = await import('../../src/main/tasks/task')
  outbox = await import('../../src/main/outbox/outbox-store')
  foreignTasks = await import('../../src/main/tasks/foreign-tasks')
  taskApplier = await import('../../src/main/tasks/task-applier')
  taskTools = await import('../../src/main/tasks/task-tools')
  taskApplier.registerTaskOutboxApplier()
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

beforeAll(async () => {
  ;({ closeDb } = await import('../../src/main/db'))
})

beforeEach(() => {
  outbox.ackOutboxOps(outbox.listOutboxOps().map((op) => op.id))
})

/** A snapshot the way a dispatching client would ship it — the task exists
 *  only "elsewhere", so nothing here writes a local row for it. */
function shippedSnapshot(taskId: string, overrides: Partial<TaskSnapshot['details']['task']> = {}): TaskSnapshot {
  return {
    details: {
      task: {
        id: taskId,
        providerId: 'local',
        projectKey: '/home/dev/solus',
        kind: 'task',
        title: 'Fix the scroll bug',
        body: 'Restore scrollback after refresh.',
        status: 'in_progress',
        url: null,
        labels: [],
        ...overrides,
      } as TaskSnapshot['details']['task'],
      subtasks: [],
      comments: [],
      links: [],
      events: [],
    },
    parent: null,
    sessions: [],
  }
}

function toolContext(sessionId: string) {
  return {
    cwd: process.cwd(),
    sessionId: () => sessionId,
    emit: () => {},
  } as never
}

describe('the host outbox (ADR-0007)', () => {
  test('record → list → apply → ack is the whole lifecycle, and redelivery is a no-op', async () => {
    // WHY: the op id is the idempotence key end to end. A lost ack means the
    // client redelivers, and the applied-ops guard must make that harmless.
    const task = await createTask({ title: 'Owned here', projectKey: '/p', body: '' })
    const op = outbox.recordOutboxOp({
      domain: 'tasks',
      resourceId: task.id,
      name: 'comment',
      payload: { body: 'from the borrowed machine', author: 'agent' },
      sessionId: 'session-1',
    })

    expect(outbox.listOutboxOps().map((listed) => listed.id)).toContain(op.id)

    const first = await outbox.applyOutboxOps([op])
    expect(first.applied).toEqual([op.id])
    const redelivered = await outbox.applyOutboxOps([op])
    expect(redelivered.applied).toEqual([op.id])

    const details = await (await TaskModule.Task.byId(task.id)).details()
    const matching = details.comments.filter((comment) => comment.id === op.id)
    expect(matching.length).toBe(1)
    expect(matching[0].body).toBe('from the borrowed machine')

    outbox.ackOutboxOps([op.id])
    expect(outbox.listOutboxOps().find((listed) => listed.id === op.id)).toBeUndefined()
  })

  test('a replayed status op cannot regress a later human change', async () => {
    // WHY: last-write-wins must mean "last recorded", not "last delivered". The
    // guard skips an already-applied op instead of trusting timestamps.
    const task = await createTask({ title: 'Status races', projectKey: '/p', body: '' })
    const op = outbox.recordOutboxOp({
      domain: 'tasks',
      resourceId: task.id,
      name: 'set-status',
      payload: { status: 'in_review' },
      sessionId: 'session-1',
    })
    await outbox.applyOutboxOps([op])
    expect((await TaskModule.Task.byId(task.id)).status).toBe('in_review')

    // A human moves it afterwards; the same op redelivers (lost ack).
    await (await TaskModule.Task.byId(task.id)).update({ status: 'done' })
    const redelivered = await outbox.applyOutboxOps([op])
    expect(redelivered.applied).toEqual([op.id])
    expect((await TaskModule.Task.byId(task.id)).status).toBe('done')
    outbox.ackOutboxOps([op.id])
  })

  test('an op against a deleted task dead-letters instead of redelivering forever', async () => {
    const task = await createTask({ title: 'Doomed', projectKey: '/p', body: '' })
    const op = outbox.recordOutboxOp({
      domain: 'tasks',
      resourceId: task.id,
      name: 'comment',
      payload: { body: 'too late', author: 'agent' },
    })
    await (await TaskModule.Task.byId(task.id)).delete()

    const result = await outbox.applyOutboxOps([op])
    expect(result.failed.length).toBe(1)
    expect(result.failed[0].permanent).toBe(true)

    outbox.markOutboxOpsFailed(result.failed.map(({ id, error }) => ({ id, error })))
    const listed = outbox.listOutboxOps().find((candidate) => candidate.id === op.id)
    expect(listed?.state).toBe('failed')
    outbox.ackOutboxOps([op.id])
  })
})

describe('task tools on a dispatched session (foreign task)', () => {
  const sessionId = 'dispatched-session'
  const foreignTaskId = '01JFOREIGNTASKXXXXXXXXXXXX'

  beforeEach(() => {
    foreignTasks.setForeignTaskSnapshot(sessionId, shippedSnapshot(foreignTaskId))
  })

  test('read_task answers from the shipped snapshot, not this host’s store', async () => {
    // WHY: the task's row lives on another machine. Before this, the Work
    // contract told the agent to call read_task and the call threw "not found".
    const result = await taskTools.readTaskAgentTool.execute(
      { task_id: foreignTaskId },
      toolContext(sessionId),
    )
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Fix the scroll bug')
    expect(result.text).toContain('Restore scrollback after refresh.')
  })

  test('comment_task records an op and the agent reads its own write back', async () => {
    const commented = await taskTools.commentTaskAgentTool.execute(
      { task_id: foreignTaskId, body: 'blocked on X' },
      toolContext(sessionId),
    )
    expect(commented.ok).toBe(true)

    const pending = outbox.pendingOutboxOpsFor('tasks', foreignTaskId)
    expect(pending.length).toBe(1)
    expect(pending[0].name).toBe('comment')

    const read = await taskTools.readTaskAgentTool.execute(
      { task_id: foreignTaskId },
      toolContext(sessionId),
    )
    expect(read.text).toContain('blocked on X')
  })

  test('update_task_status records an op and later snapshots re-overlay it', async () => {
    const moved = await taskTools.updateTaskStatusAgentTool.execute(
      { task_id: foreignTaskId, status: 'in_review' },
      toolContext(sessionId),
    )
    expect(moved.ok).toBe(true)
    expect(moved.text).toContain('in_review')

    // The next prompt re-ships a snapshot the owner host rendered *before* the
    // op drained; the pending overlay keeps the agent's own move visible.
    foreignTasks.setForeignTaskSnapshot(sessionId, shippedSnapshot(foreignTaskId))
    const read = await taskTools.readTaskAgentTool.execute(
      { task_id: foreignTaskId },
      toolContext(sessionId),
    )
    expect(read.text).toContain('status: in_review')
  })

  test('unsupported foreign writes fail honestly, never with "not found"', async () => {
    // WHY: "Task not found" is a lie about a task that exists on another host,
    // and it teaches the agent to re-create work that is already tracked.
    const linked = await taskTools.linkTaskSessionAgentTool.execute(
      { task_id: foreignTaskId },
      toolContext(sessionId),
    )
    expect(linked.ok).toBe(false)
    expect(linked.text).toContain('another host')

    const subtask = await taskTools.createTaskAgentTool.execute(
      { title: 'child', parent_id: foreignTaskId },
      toolContext(sessionId),
    )
    expect(subtask.ok).toBe(false)
    expect(subtask.text).toContain('another host')
  })

  test('a local task is untouched by the foreign branch', async () => {
    const task = await createTask({ title: 'Local as ever', projectKey: '/p', body: '' })
    const commented = await taskTools.commentTaskAgentTool.execute(
      { task_id: task.id, body: 'plain local comment' },
      toolContext(sessionId),
    )
    expect(commented.ok).toBe(true)
    expect(outbox.pendingOutboxOpsFor('tasks', task.id).length).toBe(0)
    const details = await (await TaskModule.Task.byId(task.id)).details()
    expect(details.comments.some((comment) => comment.body === 'plain local comment')).toBe(true)
  })
})

describe('the shipped snapshot renders the packet without a local row', () => {
  test('formatTaskContext consumes a TaskSnapshot verbatim', async () => {
    const { formatTaskContext } = await import('../../src/main/tasks/task-context')
    const snapshot = shippedSnapshot('01JSNAPSHOTONLYXXXXXXXXXXX')
    const packet = formatTaskContext(snapshot.details, snapshot.parent, snapshot.sessions)
    expect(packet).toContain('[Working On Task — "Fix the scroll bug"')
    expect(packet).toContain('Restore scrollback after refresh.')
    expect(packet).toContain('read_task')
  })
})
