import { describe, expect, test } from 'bun:test'
import type { Task, TaskSessionLink } from '@solus/contracts/task-types'
import type { Session, Tab } from '@solus/contracts/types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import { hostKey } from '@solus/client-core/host-key'

type TaskRowHarness = {
  buildDurableTaskRow: (task: Task, tabs: Map<string, string>) => SidebarTask
  session: {
    tabs: Record<string, Tab>
    sessionFor: (tabId: string) => Session | undefined
    tasksStore: { get: (taskId: string) => { sessions: TaskSessionLink[]; serverId: string | null; prLink: null }; projectKeyOf: (task: Task) => string | null }
  }
  planStore: { plans: {} }
  pendingTabByTaskId: Map<string, string[]>
  lifecycleNow: number
  liveSessionStatuses: { stateFor: () => null }
}

type SidebarStoreHarness = Pick<SessionSidebarStore, 'markTaskUnread' | 'acknowledgeTask'> & {
  catalogTasks: SidebarTask[]
  session: {
    tabs: Record<string, Tab>
    sessions: { byId: Record<string, Session> }
    sessionFor: (tabId: string) => Session | undefined
    tasksStore: {
      peek: (taskId: string) => Task | null
      get: (taskId: string) => { markRead: (read: boolean) => Promise<Task>; sessions: Array<{ sessionId: string; role: 'lead' | 'working' }>; serverId: string | null }
    }
  }
}

describe('session sidebar unread state', () => {
  test('task row reads only its lead, while worker state remains on its session', () => {
    const task = taskRecord('task-1')
    const links = [
      { taskId: task.id, sessionId: 'lead', role: 'lead', executionServerId: 'host-a', linkedAt: 1 },
      { taskId: task.id, sessionId: 'worker', role: 'working', executionServerId: 'host-a', linkedAt: 2 },
    ] as TaskSessionLink[]
    const tabs: Record<string, Tab> = { lead: tab('lead'), worker: tab('worker') }
    tabs.lead.sessionId = 'lead'
    tabs.worker.sessionId = 'worker'
    tabs.worker.hasUnread = true
    const sessions: Record<string, Session> = { lead: session('lead'), worker: session('worker') }
    // SAFETY: the test supplies the inputs read by this one row builder.
    const store = Object.create(SessionSidebarStore.prototype) as TaskRowHarness
    store.session = {
      tabs,
      sessionFor: (tabId) => sessions[tabId],
      tasksStore: { get: () => ({ sessions: links, serverId: 'host-a', prLink: null }), projectKeyOf: () => '/repo' },
    }
    store.planStore = { plans: {} }
    store.pendingTabByTaskId = new Map()
    store.lifecycleNow = 10
    store.liveSessionStatuses = { stateFor: () => null }
    const mounted = new Map([
      [hostKey('host-a', 'lead'), 'lead'],
      [hostKey('host-a', 'worker'), 'worker'],
    ])

    expect(store.buildDurableTaskRow(task, mounted).unread).toBe(false)
    expect(tabs.worker.hasUnread).toBe(true)
    tabs.lead.hasUnread = true
    expect(store.buildDurableTaskRow(task, mounted).unread).toBe(true)
    links[0].role = 'working'
    expect(store.buildDurableTaskRow(task, mounted).unread).toBe(false)
    links[1].role = 'lead'
    expect(store.buildDurableTaskRow(task, mounted).unread).toBe(true)
    links[1].executionServerId = 'host-b'
    expect(store.buildDurableTaskRow(task, mounted).unread).toBe(false)
    links[1].executionServerId = 'host-a'
    mounted.delete(hostKey('host-a', 'worker'))
    expect(store.buildDurableTaskRow(task, mounted).unread).toBe(false)
    mounted.set(hostKey('host-a', 'worker'), 'worker')
    sessions.worker.status = 'awaiting_input'
    expect(store.buildDurableTaskRow(task, mounted).status).toBe('question')
    sessions.worker.status = 'running'
    expect(store.buildDurableTaskRow(task, mounted).status).toBe('running')
    links[1].role = 'working'
    tabs.pending = { ...tab('pending'), sessionId: 'pending', hasUnread: true }
    sessions.pending = { ...session('pending'), task: { kind: 'existing', taskId: task.id, role: 'lead' } }
    store.pendingTabByTaskId.set(task.id, ['pending'])
    expect(store.buildDurableTaskRow(task, mounted).unread).toBe(true)
  })

  test('marking a task unread changes its lead tab but leaves a worker tab read', async () => {
    // WHY: the task row stands for the lead conversation. A worker still has
    // its own unread state when it is opened in session mode.
    const task = taskRecord('task-1')
    // SAFETY: the test calls one prototype method and supplies every field that
    // method reads below; the Svelte constructor is intentionally bypassed.
    const store = Object.create(SessionSidebarStore.prototype) as SidebarStoreHarness
    store.catalogTasks = [sidebarTask(task.id, ['tab-a', 'tab-b'])]
    store.session = {
      sessions: { byId: {} },
      tabs: {
        'tab-a': tab('tab-a'),
        'tab-b': tab('tab-b'),
      },
      sessionFor: (tabId) => session(`session-${tabId}`),
      tasksStore: {
        peek: () => task,
        get: () => ({ markRead: async (_read) => task, serverId: 'host-a', sessions: [
          { sessionId: 'session-tab-a', role: 'lead' },
          { sessionId: 'session-tab-b', role: 'working' },
        ] }),
      },
    }

    await store.markTaskUnread(task.id)

    expect(store.session.tabs['tab-a'].hasUnread).toBe(true)
    expect(store.session.tabs['tab-b'].hasUnread).toBe(false)
  })

  test('marking a task with no lead does not mark a worker unread', async () => {
    const task = taskRecord('task-1')
    let writes = 0
    // SAFETY: this supplies the fields read by markTaskUnread only.
    const store = Object.create(SessionSidebarStore.prototype) as SidebarStoreHarness
    store.catalogTasks = [sidebarTask(task.id, ['worker'])]
    store.session = {
      sessions: { byId: {} },
      tabs: { worker: { ...tab('worker'), sessionId: 'worker' } },
      sessionFor: () => session('worker'),
      tasksStore: {
        peek: () => task,
        get: () => ({ markRead: async () => { writes++; return task }, sessions: [
          { sessionId: 'worker', role: 'working' },
        ], serverId: 'host-a' }),
      },
    }

    await store.markTaskUnread(task.id)
    expect(store.session.tabs.worker.hasUnread).toBe(false)
    expect(writes).toBe(0)
  })

  test('opening a task writes its read time only when the row is woken', () => {
    // WHY: the read time exists to clear a woken snooze. Writing it on every
    // click makes the host invalidate all task surfaces, which re-read the
    // sidebar snapshot and every watched task detail for no visible change.
    const record = taskRecord('root')
    const marked: string[] = []
    // SAFETY: the test calls one prototype method and supplies every field that
    // method reads below; the Svelte constructor is intentionally bypassed.
    const store = Object.create(SessionSidebarStore.prototype) as SidebarStoreHarness
    const row = sidebarTask('root', ['root-tab'])
    store.catalogTasks = [row]
    store.session = {
      sessions: { byId: {} },
      tabs: {},
      sessionFor: () => undefined,
      tasksStore: {
        peek: () => record,
        get: (taskId) => ({ markRead: async () => { marked.push(taskId); return record }, sessions: [], serverId: null }),
      },
    }

    store.acknowledgeTask(record.id)
    expect(marked).toEqual([])

    row.woke = true
    store.acknowledgeTask(record.id)
    expect(marked).toEqual(['root'])
  })
})

function taskRecord(id: string): Task {
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

function sidebarTask(taskId: string, tabIds: string[]): SidebarTask {
  return {
    id: taskId,
    taskId,
    key: taskId,
    title: taskId,
    projectKey: '/repo',
    projectLabel: 'repo',
    branchName: null,
    serverId: null,
    prNumber: null,
    status: 'idle',
    attention: null,
    unread: false,
    createdAt: 0,
    runStartedAt: 0,
    lifecycle: 'active',
    completedAt: 0,
    snoozedUntil: 0,
    snoozeNote: null,
    lastReadAt: 0,
    woke: false,
    tabIds,
  }
}

function tab(id: string): Tab {
  return { id, sessionId: `session-${id}`, hasUnread: false }
}

function session(id: string): Session {
  return {
    id,
    status: 'completed',
    task: { kind: 'none' },
    handoffId: id,
    agentSessionId: id,
    run: { serverId: 'host-a' },
    permissionQueue: [],
    questionQueue: [],
    messages: [],
  } as Session
}
