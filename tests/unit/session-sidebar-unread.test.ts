import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import type { Session, Tab } from '@solus/contracts/types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

type SidebarStoreHarness = Pick<SessionSidebarStore, 'markTaskUnread' | 'acknowledgeTask'> & {
  catalogTasks: SidebarTask[]
  session: {
    tabs: Record<string, Tab>
    sessions: { byId: Record<string, Session> }
    tasksStore: {
      peek: (taskId: string) => Task | null
      get: (taskId: string) => { markRead: (read: boolean) => Promise<Task> }
    }
  }
}

describe('session sidebar unread state', () => {
  test('marking a task unread sets the mounted tab flags that drive its blue dot', async () => {
    // WHY: the durable task timestamp does not render the session unread dot;
    // the row aggregates the mounted tabs' hasUnread flags.
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
      tasksStore: {
        peek: () => task,
        get: () => ({ markRead: async (_read) => task }),
      },
    }

    await store.markTaskUnread(task.id)

    expect(store.session.tabs['tab-a'].hasUnread).toBe(true)
    expect(store.session.tabs['tab-b'].hasUnread).toBe(true)
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
      tasksStore: {
        peek: () => record,
        get: (taskId) => ({ markRead: async () => { marked.push(taskId); return record } }),
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
    listKey: taskId,
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
