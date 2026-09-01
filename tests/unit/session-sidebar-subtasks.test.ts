import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

type SidebarStoreHarness = Pick<SessionSidebarStore, 'sessionsFor'> & {
  session: unknown
  visibleTabIds: string[]
  pendingTabByTaskId: Map<string, unknown>
  dismissedRowKeys: Set<string>
  tabIdBySessionId: Map<string, string>
  sessionsByTaskId: Map<string, unknown>
  automaticRootBySessionIdentity: Map<string, string>
  projectsSessionUnder(rootTaskId: string, sessionId: string): boolean
}

function sidebarStore(): SidebarStoreHarness {
  return Object.create(SessionSidebarStore.prototype) as SidebarStoreHarness
}

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
  test('projects a linked session once unless the user explicitly opens another task', () => {
    // WHY: task-session links are many-to-many, but background hydration must
    // not turn every relationship into another copy of the same conversation.
    const store = sidebarStore()
    store.tabIdBySessionId = new Map([['provider-session', 'tab-1']])
    store.automaticRootBySessionIdentity = new Map([['tab-1', 'first-task']])
    store.session = {
      hasExplicitSidebarTaskSession: (taskId: string, sessionId: string) =>
        taskId === 'second-task' && sessionId === 'provider-session',
    }

    expect(store.projectsSessionUnder('first-task', 'provider-session')).toBe(true)
    expect(store.projectsSessionUnder('unopened-task', 'provider-session')).toBe(false)
    expect(store.projectsSessionUnder('second-task', 'provider-session')).toBe(true)
  })

  test('shows an unstarted subtask by its own name', () => {
    // WHY: the task tree exists before its provider sessions. Hiding or naming
    // that row after the parent makes the sidebar unable to represent the plan.
    const root = task('root', 'Ship the release')
    const subtask = task('child', 'Verify the release', root.id)
    const store = sidebarStore()
    store.session = {
      tasksStore: {
        tasks: [root, subtask],
        byParent: new Map([[root.id, [subtask]]]),
        get: () => ({ sessions: [], serverId: null }),
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
    // WHY: a fork's subtask is only minted after its first turn. Until then the
    // sidebar has to place it by the parent it will hang under, or the fork is
    // projected as a loose session sitting outside the task it came from.
    const root = task('root', 'Ship the release')
    const store = sidebarStore()
    store.session = { tasksStore: { tasks: [root] } }
    const resolve = (session: unknown) =>
      (store as unknown as { pendingTaskFor(session: unknown): Task | undefined }).pendingTaskFor(session)

    expect(resolve({ task: { kind: 'new', parentTaskId: root.id } })).toBe(root)
    expect(resolve({ task: { kind: 'new' } })).toBeUndefined()
  })

  test('a closed attempt reports the host it ran on, not the reader', () => {
    // WHY: the row states a machine unconditionally, so with no tab to ask it
    // used to assert "this machine" for every closed attempt — including a
    // session dispatched to another host, which is the one case where the mark
    // is the only thing that could have told you.
    const root = task('root', 'Ship the release')
    const store = sidebarStore()
    store.session = {
      tasksStore: {
        tasks: [root],
        byParent: new Map(),
        // The task's own host answers for a link that recorded none: not a
        // dispatch means it ran wherever the task lives.
        get: () => ({
          serverId: 'workshop',
          sessions: [
            { taskId: root.id, sessionId: 'dispatched', sessionTitle: 'On Studio', provider: 'claude', startedAt: 2, lastActivityAt: 2, executionServerId: 'studio', linkedAt: 2 },
            { taskId: root.id, sessionId: 'here', sessionTitle: 'At home', provider: 'claude', startedAt: 1, lastActivityAt: 1, executionServerId: null, linkedAt: 1 },
          ],
        }),
      },
    }
    store.visibleTabIds = []
    store.pendingTabByTaskId = new Map()
    store.dismissedRowKeys = new Set()
    store.tabIdBySessionId = new Map()
    store.sessionsByTaskId = new Map()

    const rows = store.sessionsFor({ id: root.id, taskId: root.id, tabIds: [] } as unknown as SidebarTask)
    expect(rows.map((row) => [row.sessionId, row.serverId])).toEqual([
      ['here', 'workshop'],
      ['dispatched', 'studio'],
    ])
  })
})
