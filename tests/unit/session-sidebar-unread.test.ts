import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import type { Tab } from '@solus/contracts/types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

type SidebarStoreHarness = Pick<SessionSidebarStore, 'markTaskUnread'> & {
  catalogTasks: SidebarTask[]
  session: {
    tabs: Record<string, Tab>
    tasksStore: {
      taskForId: (taskId: string) => Task | null
      markRead: (taskId: string, read: boolean) => Promise<Task>
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
      tabs: {
        'tab-a': tab('tab-a'),
        'tab-b': tab('tab-b'),
      },
      tasksStore: {
        taskForId: () => task,
        markRead: async (_taskId, _read) => task,
      },
    }

    await store.markTaskUnread(task.id)

    expect(store.session.tabs['tab-a'].hasUnread).toBe(true)
    expect(store.session.tabs['tab-b'].hasUnread).toBe(true)
  })

  test('a subtask marks the root row session flags unread', async () => {
    // WHY: subtasks render inside one root rollup, so their unread state must
    // reach the tabs that the visible root row aggregates.
    const child = taskRecord('child', 'root')
    // SAFETY: the test calls one prototype method and supplies every field that
    // method reads below; the Svelte constructor is intentionally bypassed.
    const store = Object.create(SessionSidebarStore.prototype) as SidebarStoreHarness
    store.catalogTasks = [sidebarTask('root', ['child-tab'])]
    store.session = {
      tabs: { 'child-tab': tab('child-tab') },
      tasksStore: {
        taskForId: () => child,
        markRead: async (_taskId, _read) => child,
      },
    }

    await store.markTaskUnread(child.id)

    expect(store.session.tabs['child-tab'].hasUnread).toBe(true)
  })
})

function taskRecord(id: string, parentId?: string): Task {
  return {
    id,
    providerId: 'local',
    projectKey: '/repo',
    parentId,
    kind: 'task',
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
    activityAt: 0,
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
