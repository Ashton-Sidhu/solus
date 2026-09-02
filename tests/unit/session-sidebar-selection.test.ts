import { describe, expect, test } from 'bun:test'
import { taskSessionTarget } from '@solus/workspace-ui/contexts/workspace/session-sidebar-selection'
import {
  SessionSidebarStore,
  type SidebarSessionChild,
} from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import type { Task } from '@solus/contracts/task-types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'

type SelectionHarness = Pick<SessionSidebarStore, 'selectTask'> & {
  sessionsFor: () => SidebarSessionChild[]
  selectChild: (child: SidebarSessionChild) => Promise<void>
  selected: SidebarSessionChild[]
  session: unknown
}

function sidebarStoreForSelection(children: SidebarSessionChild[]): SelectionHarness {
  const store = Object.create(SessionSidebarStore.prototype) as SelectionHarness
  store.selected = []
  store.sessionsFor = () => children
  store.selectChild = async (child) => {
    store.selected.push(child)
  }
  store.session = { tasksStore: { tasks: [] } }
  return store
}

function child(partial: Partial<SidebarSessionChild>): SidebarSessionChild {
  return {
    label: 'run',
    attention: null,
    unread: false,
    serverId: 'studio',
    branchName: null,
    runStartedAt: 0,
    lastActivityAt: 0,
    reviewGuideStatus: null,
    ...partial,
  }
}

describe('session sidebar task selection', () => {
  test('selects the highest-priority session across mounted and remote work', () => {
    const running = child({ tabId: 'running', attention: 'running', lastActivityAt: 30 })
    const asking = child({ sessionId: 'asking', attention: 'awaiting', lastActivityAt: 10 })

    expect(taskSessionTarget([running, asking])).toBe(asking)
  })

  test('breaks equal-priority ties with the latest known session activity', () => {
    const older = child({ sessionId: 'older', attention: 'running', lastActivityAt: 10 })
    const newer = child({ sessionId: 'newer', attention: 'running', lastActivityAt: 20 })

    expect(taskSessionTarget([older, newer])).toBe(newer)
  })
})

describe('clicking a task whose question is not open here', () => {
  test('opens the asking session instead of the tab that is mounted', async () => {
    // The phone case: the work runs on a desktop, so the session holding the
    // question has no tab here. Ranking only mounted tabs left it unreachable.
    const asking = child({ sessionId: 'asked', attention: 'awaiting' })
    const store = sidebarStoreForSelection([
      child({ tabId: 'mounted-tab', sessionId: 'mounted' }),
      asking,
    ])

    await store.selectTask({ key: 'task', tabIds: ['mounted-tab'] } as SidebarTask)

    expect(store.selected).toEqual([asking])
  })

  test('a plan waiting for approval asks just as loudly', async () => {
    const asking = child({ sessionId: 'planned', attention: 'awaiting_plan' })
    const store = sidebarStoreForSelection([asking])

    await store.selectTask({ key: 'task', tabIds: [] } as unknown as SidebarTask)

    expect(store.selected).toEqual([asking])
  })

  test('a session already open here is selected directly', async () => {
    const store = sidebarStoreForSelection([
      child({ tabId: 'mounted-tab', sessionId: 'mounted', attention: 'awaiting' }),
    ])

    await store.selectTask({ key: 'task', tabIds: ['mounted-tab'] } as SidebarTask)

    expect(store.selected).toEqual([
      child({ tabId: 'mounted-tab', sessionId: 'mounted', attention: 'awaiting' }),
    ])
  })

  test('newer equal-priority work wins across mounted and remote sessions', async () => {
    const store = sidebarStoreForSelection([
      child({ tabId: 'mounted-tab', sessionId: 'mounted', lastActivityAt: 10 }),
      child({ sessionId: 'remote', lastActivityAt: 20 }),
    ])

    await store.selectTask({ key: 'task', tabIds: ['mounted-tab'] } as SidebarTask)

    expect(store.selected).toEqual([child({ sessionId: 'remote', lastActivityAt: 20 })])
  })
})

describe('selecting a task from the picker', () => {
  test('restores the row, then opens the session the picker listed', async () => {
    // WHY: the picker lists a task's sessions without needing a sidebar row for
    // it. Selecting through the row instead sent every task this client has not
    // opened to a new draft, contradicting the list the reader just read.
    const listed = child({ sessionId: 'remote', lastActivityAt: 20 })
    const selected: SidebarSessionChild[] = []
    const restored: string[] = []
    const store = Object.create(SessionSidebarStore.prototype) as SessionSidebarStore
    Object.defineProperty(store, 'session', {
      value: { tasksStore: { peek: () => null } },
    })
    store.restoreTask = (taskId) => restored.push(taskId)
    store.sessionsForPickableTask = () => [listed]
    store.selectChild = async (session) => {
      selected.push(session)
    }

    await store.selectTaskRecord({ id: 'task-1' } as Task)

    expect(restored).toEqual(['task-1'])
    expect(selected).toEqual([listed])
  })
})
