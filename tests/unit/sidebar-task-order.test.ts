import { describe, expect, it } from 'bun:test'
import {
  compareTaskCreationOrder,
  sortSidebarRowsBySessionOrder,
  sortTasksByCreation,
  type SidebarTask,
  type TaskStatus,
} from '@solus/workspace-ui/components/session/lib/task-list'

function sidebarTask(
  id: string,
  status: TaskStatus,
  createdAt: number,
): SidebarTask {
  return {
    id,
    key: id,
    title: id,
    projectKey: '/repos/solus',
    projectLabel: 'solus',
    branchName: id,
    serverId: null,
    prNumber: null,
    status,
    attention: null,
    unread: false,
    createdAt,
    activityAt: 0,
    runStartedAt: 0,
    tabIds: [id],
  }
}

function task(id: string, shortId: number, createdAt: number, updatedAt = createdAt) {
  return {
    id,
    shortId,
    providerId: 'local' as const,
    projectKey: '/repos/solus',
    kind: 'task' as const,
    title: id,
    titleSource: 'manual' as const,
    body: '',
    status: 'todo' as const,
    url: null,
    labels: [],
    canEditPlanningFields: true,
    source: 'user' as const,
    createdAt,
    updatedAt,
  }
}

describe('sortTasksByCreation', () => {
  it('rebuilds the same oldest-first order after a refresh returns newest-updated first', () => {
    const oldest = task('oldest', 1, 1_000, 9_000)
    const middle = task('middle', 2, 2_000, 2_000)
    const newest = task('newest', 3, 3_000, 8_000)
    const refreshed = [oldest, newest, middle]

    expect(sortTasksByCreation(refreshed).map((item) => item.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ])
    expect(refreshed.map((item) => item.id)).toEqual(['oldest', 'newest', 'middle'])
  })
})

describe('sortSidebarRowsBySessionOrder', () => {
  it('restores the persisted session order without grouping task-backed rows first', () => {
    const firstTask = sidebarTask('task-row-1', 'idle', 1_000)
    firstTask.taskId = 'task-1'
    const looseSession = sidebarTask('loose-session', 'idle', 2_000)
    const secondTask = sidebarTask('task-row-2', 'idle', 3_000)
    secondTask.taskId = 'task-2'

    expect(
      sortSidebarRowsBySessionOrder(
        [firstTask, secondTask, looseSession],
        ['task-row-1', 'loose-session', 'task-row-2'],
      ).map((item) => item.id),
    ).toEqual(['task-row-1', 'loose-session', 'task-row-2'])
  })

  it('places a multi-session task at its first tab and closed tasks afterward', () => {
    const multiSessionTask = sidebarTask('task-row', 'idle', 3_000)
    multiSessionTask.tabIds = ['later-tab', 'earlier-tab']
    const looseSession = sidebarTask('loose-session', 'idle', 2_000)
    const closedTask = sidebarTask('closed-task', 'idle', 1_000)
    closedTask.tabIds = []

    expect(
      sortSidebarRowsBySessionOrder(
        [closedTask, looseSession, multiSessionTask],
        ['earlier-tab', 'loose-session', 'later-tab'],
      ).map((item) => item.id),
    ).toEqual(['task-row', 'loose-session', 'closed-task'])
  })
})

describe('compareTaskCreationOrder', () => {
  it('uses the monotonic short id when tasks share a creation millisecond', () => {
    const older = task('Z-random-suffix', 41, 1_000)
    const newer = task('A-random-suffix', 42, 1_000)

    expect(
      [newer, older].sort(compareTaskCreationOrder).map((item) => item.shortId),
    ).toEqual([41, 42])
  })
})
