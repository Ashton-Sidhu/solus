import { describe, expect, it } from 'bun:test'
import {
  sortSidebarRowsByCreation,
  type SidebarTask,
  type TaskStatus,
} from '@solus/workspace-ui/components/session/lib/task-list'

function sidebarTask(
  id: string,
  status: TaskStatus,
  createdAt: number,
): SidebarTask {
  // SAFETY: the sort reads only a row's identity and creation time.
  return {
    id,
    key: id,
    title: id,
    projectKey: '/repos/solus',
    projectLabel: 'solus',
    branchName: id,
    serverId: null,
    status,
    attention: null,
    unread: false,
    createdAt,
    runStartedAt: 0,
    tabIds: [id],
  } as SidebarTask
}

describe('sortSidebarRowsByCreation', () => {
  it('keeps rows in their fixed creation order, newest first, linked to a task or not', () => {
    // WHY: new work lands at the top, and a link to a task never moves a
    // session out of the order the user already learned.
    const oldest = sidebarTask('oldest', 'idle', 1_000)
    oldest.linkedTask = { taskId: 'task-1', title: 'Task' }
    const middle = sidebarTask('middle', 'idle', 2_000)
    const newest = sidebarTask('newest', 'idle', 3_000)

    expect(
      sortSidebarRowsByCreation([oldest, newest, middle]).map((item) => item.id),
    ).toEqual(['newest', 'middle', 'oldest'])
  })

  it('does not move a row when its tab opens or closes', () => {
    const mounted = sidebarTask('mounted', 'idle', 3_000)
    const middle = sidebarTask('middle', 'idle', 2_000)
    const closed = sidebarTask('closed', 'idle', 1_000)
    closed.tabIds = []

    expect(
      sortSidebarRowsByCreation([closed, mounted, middle]).map((item) => item.id),
    ).toEqual(['mounted', 'middle', 'closed'])
  })
})
