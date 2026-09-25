import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

type RowVisibilityHarness = {
  session: unknown
  pendingTabByTaskId: Map<string, string[]>
  dismissedRowKeys: Set<string>
  openTaskIds: Set<string>
  isDurableRowShown(task: Task, openTabBySessionId: Map<string, string>): boolean
}

function task(id: string): Task {
  return {
    id,
    providerId: 'local',
    projectKey: '/repo',
    title: id,
    body: '',
    status: 'in_progress',
    url: null,
    labels: [],
    updatedAt: 0,
  }
}

function store(pendingTaskIds: string[], openTaskIds: string[] = []): RowVisibilityHarness {
  const harness = Object.create(SessionSidebarStore.prototype) as RowVisibilityHarness
  harness.session = {
    tasksStore: {
      // No session is linked yet: the task was minted a moment ago.
      get: () => ({ sessions: [] }),
    },
  }
  harness.pendingTabByTaskId = new Map(pendingTaskIds.map((taskId) => [taskId, [`tab-for-${taskId}`]]))
  harness.dismissedRowKeys = new Set()
  harness.openTaskIds = new Set(openTaskIds)
  return harness
}

describe('a new session becoming a task row', () => {
  test('the task row shows in the same pass that retires the loose row', () => {
    // WHY: the loose row leaves as soon as the session names its task, but the
    // task used to wait for an effect to add it to the open set. For one render
    // the session had no row at all, so the list faded it out and back in.
    const minted = task('minted')
    expect(store(['minted']).isDurableRowShown(minted, new Map())).toBe(true)
  })

  test('a task nobody has open and no tab waits on stays off the column', () => {
    expect(store([]).isDurableRowShown(task('elsewhere'), new Map())).toBe(false)
  })

  test('a task already open on this client still shows without a waiting tab', () => {
    expect(store([], ['open']).isDurableRowShown(task('open'), new Map())).toBe(true)
  })

  test('a task shows while one of its sessions is open in a tab, with no copy in the open set', () => {
    // WHY: the open set is written only when a tab closes. While the tab is
    // open, the tab itself is what puts the row in the column.
    const linked = store([])
    linked.session = {
      tasksStore: {
        get: () => ({ sessions: [{ sessionId: 'session-1', role: 'working' }] }),
      },
    }
    expect(linked.isDurableRowShown(task('linked'), new Map([['session-1', 'tab-1']]))).toBe(true)
    expect(linked.isDurableRowShown(task('linked'), new Map())).toBe(false)
  })
})

type ReleaseHarness = {
  session: unknown
  catalogTasks: Array<{ id: string; taskId?: string; tabIds: string[] }>
  dismissedRowKeys: Set<string>
  openTaskIds: Set<string>
  releaseTab(tabId: string): void
}

function releasing(dismissed: string[] = []): ReleaseHarness {
  const harness = Object.create(SessionSidebarStore.prototype) as ReleaseHarness
  harness.session = {
    sidebarTaskContextForTab: () => null,
    sessionFor: () => null,
    tasksStore: { loaded: true, tasks: [{ id: 'task-1' }] },
  }
  harness.catalogTasks = [{ id: 'task-1', taskId: 'task-1', tabIds: ['tab-1'] }]
  harness.dismissedRowKeys = new Set(dismissed)
  harness.openTaskIds = new Set()
  return harness
}

describe('closing a tab', () => {
  test("keeps the tab's task in the column after its last tab closes", () => {
    // WHY: a task the user had open here stays listed until its row is closed.
    // The open set is the only record of that once no tab shows the task.
    const harness = releasing()
    harness.releaseTab('tab-1')
    expect([...harness.openTaskIds]).toEqual(['task-1'])
  })

  test('leaves a task the user dismissed off the column', () => {
    // WHY: closing a row dismisses its task and then closes its tabs; the
    // closing tabs must not put the row straight back.
    const harness = releasing(['task-1'])
    harness.releaseTab('tab-1')
    expect([...harness.openTaskIds]).toEqual([])
  })
})
