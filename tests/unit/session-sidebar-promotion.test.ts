import { afterAll, describe, expect, test } from 'bun:test'
import type { Task, TaskSessionLink } from '@solus/contracts/task-types'

// The store's import chain reaches module-level stores built with `$state`,
// which only the Svelte compiler provides. Bun runs the source as written, so
// the rune is stood in for before the chain loads, as tab-registry.test.ts does.
const runes = globalThis as unknown as { $state?: unknown }
const previousState = runes.$state
runes.$state = <T>(value: T) => value
const { SessionSidebarStore } = await import('@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte')
afterAll(() => {
  if (previousState === undefined) delete runes.$state
  else runes.$state = previousState
})

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

function link(sessionId: string, role: TaskSessionLink['role']): TaskSessionLink {
  // SAFETY: the rule reads only a link's session and role.
  return { sessionId, role } as TaskSessionLink
}

function store(options: {
  links?: TaskSessionLink[]
  pendingTaskIds?: string[]
  openTaskIds?: string[]
  dismissed?: string[]
} = {}): RowVisibilityHarness {
  const harness = Object.create(SessionSidebarStore.prototype) as RowVisibilityHarness
  harness.session = {
    tasksStore: { get: () => ({ sessions: options.links ?? [] }) },
    sessionFor: () => undefined,
  }
  harness.pendingTabByTaskId = new Map((options.pendingTaskIds ?? []).map((taskId) => [taskId, [`tab-for-${taskId}`]]))
  harness.dismissedRowKeys = new Set(options.dismissed ?? [])
  harness.openTaskIds = new Set(options.openTaskIds ?? [])
  return harness
}

const mounted = new Map([['worker', 'worker-tab'], ['lead', 'lead-tab']])

describe('which tasks have a row in the Tasks section', () => {
  test("a task's other session does not open the task here", () => {
    // WHY: the Tasks section lists the tasks a person opened. A session that
    // is only linked to a task keeps its own row in Sessions, with the task on
    // a chip, until the task is opened (docs/plans/task-conversation.md,
    // decision 5).
    expect(store({ links: [link('worker', 'working')] }).isDurableRowShown(task('linked'), mounted)).toBe(false)
    expect(store({ pendingTaskIds: ['linked'] }).isDurableRowShown(task('linked'), new Map())).toBe(false)
  })

  test('a task nobody has open stays off the column', () => {
    expect(store().isDurableRowShown(task('elsewhere'), new Map())).toBe(false)
  })

  test('a task opened on this client has a row, with or without a session', () => {
    expect(store({ openTaskIds: ['open'] }).isDurableRowShown(task('open'), new Map())).toBe(true)
    expect(store({ links: [link('worker', 'working')], openTaskIds: ['open'] }).isDurableRowShown(task('open'), mounted))
      .toBe(true)
  })

  test('a mounted lead opens its task, even after the row was removed', () => {
    // The row stands for the lead's conversation, so an open lead is a row.
    const led = store({ links: [link('lead', 'lead')], dismissed: ['led'] })
    expect(led.isDurableRowShown(task('led'), mounted)).toBe(true)
    expect(led.isDurableRowShown(task('led'), new Map())).toBe(false)
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
