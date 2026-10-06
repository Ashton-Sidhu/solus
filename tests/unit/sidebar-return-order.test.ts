import { describe, expect, it } from 'bun:test'
import { SidebarReturnOrder } from '@solus/workspace-ui/components/session/lib/sidebar-return-order'
import {
  sortRowsByReturn,
  type SidebarTask,
  type TaskStatus,
} from '@solus/workspace-ui/components/session/lib/task-list'

function row(id: string, status: TaskStatus, createdAt: number, taskId?: string): SidebarTask {
  // SAFETY: the return order reads only a row's identity, task, status, and creation time.
  return { id, key: id, taskId, status, createdAt } as SidebarTask
}

function order(returnOrder: SidebarReturnOrder, rows: SidebarTask[]): string[] {
  return sortRowsByReturn(rows, (candidate) => returnOrder.returnedAt(candidate)).map((candidate) => candidate.id)
}

describe('SidebarReturnOrder', () => {
  it('moves a row to the top only when this client sees it leave the Working section', () => {
    // WHY: a row that comes back to you has something new, so it lands on top.
    const returnOrder = new SidebarReturnOrder()
    returnOrder.observe([row('old', 'running', 1_000), row('new', 'idle', 2_000)], 5_000)
    returnOrder.observe([row('old', 'question', 1_000), row('new', 'idle', 2_000)], 6_000)

    expect(order(returnOrder, [row('old', 'question', 1_000), row('new', 'idle', 2_000)])).toEqual(['old', 'new'])
  })

  it('keeps rows still when they are opened, loaded, or first seen', () => {
    // WHY: clicking a session must not move it. Only a seen change of status
    // stamps a row; the first observation (mount, reload) is a baseline.
    const returnOrder = new SidebarReturnOrder()
    const rows = [row('a', 'idle', 1_000), row('b', 'error', 3_000), row('c', 'idle', 2_000)]
    returnOrder.observe(rows, 5_000)
    returnOrder.observe(rows, 6_000)

    expect(order(returnOrder, rows)).toEqual(['b', 'c', 'a'])
  })

  it('keeps a task row in place when its lead or workers start and stop', () => {
    // WHY: the user decided tasks do not move while agents run. A task row
    // stays in Tasks, so a finished run must not lift it to the top either.
    const returnOrder = new SidebarReturnOrder()
    const tasks = (leadStatus: TaskStatus, workerStatus: TaskStatus) => [
      row('lead-task', leadStatus, 1_000, 'lead-task'),
      row('worker-task', workerStatus, 2_000, 'worker-task'),
      row('newest', 'idle', 3_000, 'newest'),
    ]
    returnOrder.observe(tasks('idle', 'idle'), 5_000)
    returnOrder.observe(tasks('running', 'background'), 6_000)
    returnOrder.observe(tasks('idle', 'question'), 7_000)
    returnOrder.observe(tasks('limit', 'idle'), 8_000)
    returnOrder.observe(tasks('error', 'idle'), 9_000)

    expect(order(returnOrder, tasks('error', 'idle'))).toEqual(['newest', 'worker-task', 'lead-task'])
  })

  it('still lifts a session row that comes back from the Working section', () => {
    const returnOrder = new SidebarReturnOrder()
    returnOrder.observe([row('session', 'running', 1_000), row('task', 'running', 2_000, 'task')], 5_000)
    returnOrder.observe([row('session', 'idle', 1_000), row('task', 'idle', 2_000, 'task')], 6_000)

    expect(returnOrder.returnedAt(row('session', 'idle', 1_000))).toBe(6_000)
    expect(returnOrder.returnedAt(row('task', 'idle', 2_000, 'task'))).toBe(2_000)
  })

  it('forgets a row that left the column', () => {
    const returnOrder = new SidebarReturnOrder()
    returnOrder.observe([row('a', 'running', 1_000)], 5_000)
    returnOrder.observe([row('a', 'idle', 1_000)], 6_000)
    returnOrder.observe([], 7_000)

    expect(returnOrder.returnedAt(row('a', 'idle', 1_000))).toBe(1_000)
  })
})
