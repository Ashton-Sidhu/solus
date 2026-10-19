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

// WHY: the next/previous-session keys must walk the rows in the order the
// sidebar lists them — tasks, then sessions, then working — not the order tabs
// were opened. Otherwise the key jumps to a row that is not the one below.
describe('next and previous session keys', () => {
  function harness(onScreenTaskId: string | null) {
    const opened: string[] = []
    const store = Object.create(SidebarStoreClass.prototype) as SessionSidebarStore
    const row = (id: string) => ({ id }) as SidebarTask
    Object.defineProperties(store, {
      taskRows: { value: [row('task')] },
      sessionRows: { value: [row('session-a'), row('session-b')] },
      workingRows: { value: [row('working')] },
      onScreenTaskId: { value: onScreenTaskId },
    })
    store.selectTask = async (task) => { opened.push(task.id) }
    return { store, opened }
  }

  test('moves to the row listed below, across sections, and wraps to the top', async () => {
    const { store, opened } = harness('session-b')
    await store.selectAdjacentRow(1)
    expect(opened).toEqual(['working'])

    const last = harness('working')
    await last.store.selectAdjacentRow(1)
    expect(last.opened).toEqual(['task'])
  })

  test('moves to the row listed above and wraps to the bottom', async () => {
    const { store, opened } = harness('session-a')
    await store.selectAdjacentRow(-1)
    expect(opened).toEqual(['task'])

    const first = harness('task')
    await first.store.selectAdjacentRow(-1)
    expect(first.opened).toEqual(['working'])
  })

  test('with no row on screen, starts from the top or the bottom', async () => {
    const down = harness(null)
    await down.store.selectAdjacentRow(1)
    expect(down.opened).toEqual(['task'])

    const up = harness(null)
    await up.store.selectAdjacentRow(-1)
    expect(up.opened).toEqual(['working'])
  })
})
