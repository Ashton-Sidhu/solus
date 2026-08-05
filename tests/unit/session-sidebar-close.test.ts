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
})
