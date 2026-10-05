import { describe, expect, it } from 'bun:test'
import { SidebarReturnOrder } from '@solus/workspace-ui/components/session/lib/sidebar-return-order'
import {
  sortRowsByReturn,
  type SidebarTask,
  type TaskStatus,
} from '@solus/workspace-ui/components/session/lib/task-list'

function row(id: string, status: TaskStatus, createdAt: number): SidebarTask {
  // SAFETY: the return order reads only a row's identity, status, and creation time.
  return { id, key: id, status, createdAt } as SidebarTask
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

  it('forgets a row that left the column', () => {
    const returnOrder = new SidebarReturnOrder()
    returnOrder.observe([row('a', 'running', 1_000)], 5_000)
    returnOrder.observe([row('a', 'idle', 1_000)], 6_000)
    returnOrder.observe([], 7_000)

    expect(returnOrder.returnedAt(row('a', 'idle', 1_000))).toBe(1_000)
  })
})
