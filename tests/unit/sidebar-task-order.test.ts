import { describe, expect, it } from 'bun:test'
import {
  compareTaskCreationOrder,
  sortSidebarRowsByCreation,
  sortTasksByCreation,
  type SidebarTask,
  type TaskStatus,
} from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

function sidebarTask(
  id: string,
  status: TaskStatus,
  createdAt: number,
): SidebarTask {
  return {
    id,
    listKey: id,
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

describe('sortSidebarRowsByCreation', () => {
  it('keeps task-backed and loose rows in their fixed creation order, newest first', () => {
    const firstTask = sidebarTask('task-row-1', 'idle', 1_000)
    firstTask.taskId = 'task-1'
    const looseSession = sidebarTask('loose-session', 'idle', 2_000)
    const secondTask = sidebarTask('task-row-2', 'idle', 3_000)
    secondTask.taskId = 'task-2'

    expect(
      sortSidebarRowsByCreation([firstTask, secondTask, looseSession]).map((item) => item.id),
    ).toEqual(['task-row-2', 'loose-session', 'task-row-1'])
  })

  it('does not move a task when its session tabs open, close, or reorder', () => {
    const multiSessionTask = sidebarTask('task-row', 'idle', 3_000)
    multiSessionTask.tabIds = ['later-tab', 'earlier-tab']
    const looseSession = sidebarTask('loose-session', 'idle', 2_000)
    const closedTask = sidebarTask('closed-task', 'idle', 1_000)
    closedTask.tabIds = []

    expect(
      sortSidebarRowsByCreation([multiSessionTask, looseSession, closedTask]).map(
        (item) => item.id,
      ),
    ).toEqual(['task-row', 'loose-session', 'closed-task'])
  })

  it('orders a late-minted task by the session start instead of the task link time', () => {
    // WHY: a task can be minted after its agent turn settles. Using the task's
    // later creation time puts an older session above a newer loose session.
    type DurableRowHarness = {
      session: {
        tasksStore: {
          projectKeyOf: (task: { projectKey?: string | null }) => string | null
          get: () => {
            serverId: null
            sessions: Array<{
              taskId: string
              sessionId: string
              sessionTitle: string
              provider: string
              startedAt: number
              lastActivityAt: number
              linkedAt: number
            }>
          }
        }
        tabs: { unused?: never }
        sessionFor: () => null
      }
      pendingTabByTaskId: Map<string, string[]>
      rowSnoozes: Map<string, never>
      lifecycleNow: number
      liveSessionStatuses: { stateFor: () => undefined }
      buildDurableTaskRow: (
        task: ReturnType<typeof task>,
        openTabBySessionId: Map<string, string>,
      ) => SidebarTask
    }
    const linkedTask = task('late-task', 1, 300)
    const store = Object.create(SessionSidebarStore.prototype) as DurableRowHarness
    store.session = {
      tasksStore: {
        projectKeyOf: (task) => task.projectKey ?? null,
        get: () => ({
          serverId: null,
          sessions: [{
            taskId: linkedTask.id,
            sessionId: 'older-session',
            sessionTitle: 'Older session',
            provider: 'codex',
            startedAt: 100,
            lastActivityAt: 150,
            linkedAt: 300,
          }],
        }),
      },
      tabs: {},
      sessionFor: () => null,
    }
    store.pendingTabByTaskId = new Map()
    store.rowSnoozes = new Map()
    store.lifecycleNow = 400
    store.liveSessionStatuses = { stateFor: () => undefined }

    const durableRow = store.buildDurableTaskRow(linkedTask, new Map())
    // A durable row is listed under its task id — the id its loose row already
    // carried when the session planned it — so the list updates it in place.
    expect(durableRow.listKey).toBe(linkedTask.id)
    const newerLooseSession = sidebarTask('newer-session', 'idle', 200)

    expect(sortSidebarRowsByCreation([newerLooseSession, durableRow]).map((item) => item.id))
      .toEqual(['newer-session', 'late-task'])
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
