import { describe, expect, test } from 'bun:test'
import type { Task } from '../../src/shared/task-types'
import type { SidebarTask } from '../../src/renderer/components/session/lib/task-list'
import { SessionSidebarStore } from '../../src/renderer/contexts/workspace/session-sidebar.store.svelte'

function task(id: string, title: string, parentId?: string): Task {
  return {
    id,
    providerId: 'local',
    projectKey: '/repo',
    parentId,
    kind: 'task',
    title,
    body: '',
    status: 'todo',
    url: null,
    labels: [],
    updatedAt: 0,
  }
}

describe('session sidebar subtask rows', () => {
  test('shows an unstarted subtask by its own name', () => {
    // WHY: the task tree exists before its provider sessions. Hiding or naming
    // that row after the parent makes the sidebar unable to represent the plan.
    const root = task('root', 'Ship the release')
    const subtask = task('child', 'Verify the release', root.id)
    const store = Object.create(SessionSidebarStore.prototype) as SessionSidebarStore & Record<string, unknown>
    store.session = {
      tasksStore: {
        tasks: [root, subtask],
        byParent: new Map([[root.id, [subtask]]]),
        sessionsByTask: new Map(),
      },
    }
    store.visibleTabIds = []
    store.pendingTabByTaskId = new Map()
    store.dismissedRowKeys = new Set()
    // The column memoizes each row's children off `allTasks`; a hand-built store
    // has no such pass, so the empty maps send this row down the build path the
    // assertion is about.
    store.tabIdBySessionId = new Map()
    store.sessionsByTaskId = new Map()

    const sidebarTask = {
      id: root.id,
      taskId: root.id,
      key: root.id,
      title: root.title,
      projectKey: '/repo',
      projectLabel: 'repo',
      branchName: null,
      serverId: null,
      prNumber: null,
      status: 'idle',
      attention: null,
      unread: false,
      createdAt: 0,
      activityAt: 0,
      runStartedAt: 0,
      tabIds: [],
    } satisfies SidebarTask

    const rows = store.sessionsFor(sidebarTask)
    expect(rows).toEqual([
      expect.objectContaining({
        taskId: 'child',
        label: 'Verify the release',
        isSubtask: true,
      }),
    ])
    expect(rows[0].sessionId).toBeUndefined()
  })

  test('a fork belongs to its source task before its own subtask exists', () => {
    // WHY: a fork's subtask is only minted at its first dispatch. Until then the
    // sidebar has to place it by the parent it will hang under, or the fork is
    // projected as a loose session sitting outside the task it came from.
    const root = task('root', 'Ship the release')
    const store = Object.create(SessionSidebarStore.prototype) as SessionSidebarStore & Record<string, unknown>
    store.session = { tasksStore: { tasks: [root] } }
    const resolve = (session: unknown) =>
      (store as unknown as { pendingTaskFor(session: unknown): Task | undefined }).pendingTaskFor(session)

    expect(resolve({ pendingTaskId: null, pendingParentTaskId: root.id })).toBe(root)
    expect(resolve({ pendingTaskId: null, pendingParentTaskId: null })).toBeUndefined()
  })
})
