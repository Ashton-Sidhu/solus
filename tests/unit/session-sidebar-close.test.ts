import { describe, expect, test } from 'bun:test'
import type { SidebarTask } from '../../src/renderer/components/session/lib/task-list'
import {
  SessionSidebarStore,
  type SidebarSessionChild,
} from '../../src/renderer/contexts/workspace/session-sidebar.store.svelte'

function sidebarStoreForDismissal(): SessionSidebarStore & Record<string, unknown> {
  const store = Object.create(SessionSidebarStore.prototype) as SessionSidebarStore &
    Record<string, unknown>
  store.doneTaskIds = new Set<string>()
  store.dismissedRowKeys = new Set<string>()
  store.closedTabIds = []
  store.unloadedCompletedTaskIds = new Set<string>()
  store.closeTabs = (tabIds: string[]) => {
    ;(store.closedTabIds as string[]).push(...tabIds)
  }
  return store
}

describe('session sidebar dismissal', () => {
  test('closing a running task unloads its session tab', () => {
    // WHY: a closed sidebar task must not still appear as an open session in
    // the picker. Its provider history remains durable and can be resumed.
    const store = sidebarStoreForDismissal()
    const task = {
      id: 'loose-tab',
      key: 'loose-tab',
      title: 'Background work',
      projectKey: '/repo',
      projectLabel: 'repo',
      branchName: null,
      serverId: null,
      prNumber: null,
      status: 'running',
      attention: 'running',
      unread: false,
      createdAt: 0,
      activityAt: 0,
      runStartedAt: 1,
      tabIds: ['loose-tab'],
    } satisfies SidebarTask

    store.closeTask(task)

    expect(store.closedTabIds).toEqual(['loose-tab'])
  })

  test('closing a running child unloads only that child tab', () => {
    const store = sidebarStoreForDismissal()
    const child = {
      tabId: 'child-tab',
      label: 'Background child',
      attention: 'running',
      serverId: null,
      branchName: null,
      runStartedAt: 1,
      reviewGuideStatus: null,
    } satisfies SidebarSessionChild

    store.closeChild(child)

    expect(store.closedTabIds).toEqual(['child-tab'])
  })

  test('closing a durable task unloads every tab in its tree and dismisses the row', () => {
    // WHY: this is the one path completion also takes, so it has to clear the
    // whole task at once — the root row's tabIds already span its subtasks, and
    // the dismissal is what removes the row rather than any lifecycle status.
    const store = sidebarStoreForDismissal()

    store.closeTask({
      id: 'root',
      taskId: 'root',
      tabIds: ['root-tab', 'child-tab'],
    } as SidebarTask)

    expect(store.closedTabIds).toEqual(['root-tab', 'child-tab'])
    expect([...(store.dismissedRowKeys as Set<string>)]).toEqual(['root'])
  })
})

describe('session sidebar project dismissal', () => {
  const taskIn = (projectKey: string, id: string, status = 'idle'): SidebarTask =>
    ({ id, taskId: id, projectKey, status, tabIds: [`${id}-tab`] }) as SidebarTask

  test('closing a project closes its tasks and leaves other projects open', () => {
    // WHY: the heading exists only while it has rows, so closing it has to take
    // exactly the rows under it — a project close that reached a neighbouring
    // project would unload conversations the user never pointed at.
    const store = sidebarStoreForDismissal()
    store.allTasks = [taskIn('/repo', 'one'), taskIn('/other', 'two'), taskIn('/repo', 'three')]

    store.closeProject('/repo')

    expect(store.closedTabIds).toEqual(['one-tab', 'three-tab'])
    expect([...(store.dismissedRowKeys as Set<string>)]).toEqual(['one', 'three'])
  })

  test('the running count only counts runs inside the project', () => {
    // WHY: it is what decides whether the close asks first, so counting another
    // project's run would make a quiet project prompt for nothing.
    const store = sidebarStoreForDismissal()
    store.allTasks = [
      taskIn('/repo', 'one', 'running'),
      taskIn('/repo', 'two'),
      taskIn('/other', 'three', 'running'),
    ]

    expect(store.runningTaskCountIn('/repo')).toBe(1)
  })
})

describe('session sidebar rename', () => {
  test('renaming a task names the task and nothing under it', async () => {
    // WHY: renaming the row in place used to carry the new title down into the
    // task's lead session as a manual rename, stamping a name onto a
    // conversation the user never renamed — and reshaping its row out from
    // under them mid-edit. The record is the only thing the edit owns.
    const store = sidebarStoreForDismissal()
    const updates: Array<[string, unknown]> = []
    const renamedTabIds: string[] = []
    store.session = {
      tasksStore: {
        update: (id: string, patch: unknown) => {
          updates.push([id, patch])
          return Promise.resolve()
        },
        sessionsByTask: new Map([['root', [{ sessionId: 'session-root' }]]]),
      },
    }
    store.tabIdBySessionId = new Map([['session-root', 'root-tab']])
    store.renameSession = (tabId: string) => {
      renamedTabIds.push(tabId)
      return Promise.resolve()
    }

    await store.renameTask(
      { id: 'root', taskId: 'root', tabIds: ['root-tab'] } as SidebarTask,
      'Ship the sidebar',
    )

    expect(updates).toEqual([['root', { title: 'Ship the sidebar' }]])
    expect(renamedTabIds).toEqual([])
  })

  test('renaming a loose row renames the tab that is standing in for it', async () => {
    // WHY: a row with no task record is named by its only conversation, so the
    // session rename *is* the rename — dropping it would leave that row
    // permanently unnameable.
    const store = sidebarStoreForDismissal()
    const renamedTabIds: string[] = []
    store.renameSession = (tabId: string) => {
      renamedTabIds.push(tabId)
      return Promise.resolve()
    }

    await store.renameTask(
      { id: 'loose-tab', tabIds: ['loose-tab'] } as SidebarTask,
      'Background work',
    )

    expect(renamedTabIds).toEqual(['loose-tab'])
  })
})
