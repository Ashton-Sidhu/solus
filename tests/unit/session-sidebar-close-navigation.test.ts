import { describe, expect, test } from 'bun:test'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import {
  SessionSidebarStore,
  type SidebarSessionChild,
} from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

function task(id: string, lifecycle: SidebarTask['lifecycle']): SidebarTask {
  // SAFETY: Close navigation reads only the identity, lifecycle, and mounted tab ids.
  return {
    id,
    lifecycle,
    tabIds: [id],
  } as SidebarTask
}

function childFor(task: SidebarTask): SidebarSessionChild[] {
  // SAFETY: Close navigation reads only the mounted child tab id.
  return task.tabIds.map((tabId) => ({ tabId }) as SidebarSessionChild)
}

describe('session sidebar close navigation', () => {
  test('selects the nearest open row instead of the generic shelved fallback', () => {
    // SAFETY: This focused harness supplies every member read by closeTabs.
    const store = Object.create(SessionSidebarStore.prototype) as any
    store.visibleTasks = [task('open-left', 'active'), task('closing', 'active')]
    store.snoozedTasks = [task('snoozed', 'snoozed')]
    store.completedTasks = [task('completed', 'completed')]
    store.sessionsFor = childFor
    const selected: string[] = []
    store.session = {
      activeTabId: 'closing',
      tabs: { 'open-left': {}, closing: {}, snoozed: {}, completed: {} },
      showsConversation: true,
      closeTab: (tabId: string) => {
        delete store.session.tabs[tabId]
        // The generic tab close path can land on a shelved conversation.
        if (tabId === 'closing') store.session.activeTabId = 'snoozed'
      },
      selectTab: (tabId: string) => {
        selected.push(tabId)
        store.session.activeTabId = tabId
      },
      openSessionDraft: () => {},
    }

    store.closeTabs(['closing'])

    expect(selected).toEqual(['open-left'])
  })

  test('opens the draft composer when no open row remains', () => {
    // SAFETY: This focused harness supplies every member read by closeTabs.
    const store = Object.create(SessionSidebarStore.prototype) as any
    store.visibleTasks = [task('closing', 'active')]
    store.snoozedTasks = [task('snoozed', 'snoozed')]
    store.completedTasks = [task('completed', 'completed')]
    store.sessionsFor = childFor
    let openedDraft = false
    store.session = {
      activeTabId: 'closing',
      tabs: { closing: {}, snoozed: {}, completed: {} },
      showsConversation: true,
      closeTab: (tabId: string) => {
        delete store.session.tabs[tabId]
        store.session.activeTabId = 'completed'
      },
      selectTab: () => {},
      openSessionDraft: () => { openedDraft = true },
    }

    store.closeTabs(['closing'])

    expect(openedDraft).toBe(true)
  })
})
