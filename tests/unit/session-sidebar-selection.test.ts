import { afterAll, describe, expect, test } from 'bun:test'
import type { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import type { Task } from '@solus/contracts/task-types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'

// The store's import chain reaches module-level stores built with `$state`,
// which only the Svelte compiler provides. Bun runs the source as written, so
// the rune is stood in for before the chain loads, as tab-registry.test.ts does.
const runes = globalThis as unknown as { $state?: unknown }
const previousState = runes.$state
runes.$state = <T>(value: T) => value
const { SessionSidebarStore: SidebarStoreClass } = await import('@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte')
afterAll(() => {
  if (previousState === undefined) delete runes.$state
  else runes.$state = previousState
})

describe('selecting a sidebar row', () => {
  test('clicking the only active session acknowledges its unread completion', () => {
    const tab = { id: 'only-tab', sessionId: 'session', hasUnread: true }
    const selected: string[] = []
    const store = Object.create(SidebarStoreClass.prototype) as SessionSidebarStore
    Object.defineProperty(store, 'session', {
      value: {
        activeTabId: tab.id,
        showsConversation: true,
        tabs: { [tab.id]: tab },
        selectTab: (tabId: string) => {
          selected.push(tabId)
          tab.hasUnread = false
        },
      },
    })

    store.selectTab(tab.id)

    expect(tab.hasUnread).toBe(false)
    expect(selected).toEqual([tab.id])
    // Once read, another click need not run the navigation work again.
    store.selectTab(tab.id)
    expect(selected).toEqual([tab.id])
  })

  // WHY: a task is talked to through its lead, with the task page beside it,
  // and a task with no lead gets a lead draft — "click a task, type"
  // (docs/plans/task-conversation.md, decisions 5 and 6). The move lives in
  // the opening command, so the picker and the row agree.
  function harness() {
    const calls: string[] = []
    const record = { id: 'task-1' } as Task
    const store = Object.create(SidebarStoreClass.prototype) as SessionSidebarStore
    Object.defineProperty(store, 'session', {
      value: {
        tasksStore: { peek: (taskId: string) => (taskId === record.id ? record : null) },
        opening: { openTask: async (task: Task) => { calls.push(`task:${task.id}`) } },
      },
    })
    store.restoreTask = (taskId) => { calls.push(`restore:${taskId}`) }
    store.selectTab = (tabId) => { calls.push(`tab:${tabId}`) }
    return { store, record, calls }
  }

  test('a task row opens the task as the split view, not one of its sessions', async () => {
    // Its other sessions are on its page, so a mounted worker does not take
    // the click.
    const { store, calls } = harness()
    await store.selectTask({ key: 'task-1', taskId: 'task-1', tabIds: ['worker-tab'] } as SidebarTask)
    expect(calls).toEqual(['task:task-1'])
  })

  test("a session row opens its conversation", async () => {
    // A session linked to a task that has no row here is still a session row.
    const { store, calls } = harness()
    await store.selectTask({
      key: 'tab-1',
      tabIds: ['tab-1'],
      linkedTask: { taskId: 'task-1', title: 'Task' },
    } as SidebarTask)
    expect(calls).toEqual(['tab:tab-1'])
  })

  test('the picker restores the task row, then opens the task the same way', async () => {
    const { store, record, calls } = harness()
    await store.selectTaskRecord(record)
    expect(calls).toEqual(['restore:task-1', 'task:task-1'])
  })
})
