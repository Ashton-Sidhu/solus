import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import type { SessionHomeHosts } from '@solus/workspace-ui/components/session/lib/session-home'

type SidebarStoreHarness = Pick<
  SessionSidebarStore,
  'childForTab' | 'sessionsFor' | 'sessionsForPickableTask'
> & {
  session: unknown
  visibleTabIds: string[]
  pendingTabByTaskId: Map<string, unknown>
  dismissedRowKeys: Set<string>
  tabIdBySessionId: Map<string, string>
  sessionsByTaskId: Map<string, unknown>
  pickerSessionsByTaskId: Map<string, unknown>
  sessionHomes: SessionHomeHosts
  liveChildFor(tabId: string): Omit<ReturnType<SessionSidebarStore['childForTab']>, 'lastActivityAt'>
  tabActivityAt(tabId: string): number
  projectsSessionUnder(
    rootTaskId: string,
    link: { sessionId: string; role?: 'working' | 'referenced' },
  ): boolean
}

/** No cloud host and every runner up: the rows merge to themselves (session-home.ts). */
const ONE_HOME: SessionHomeHosts = { isCloudHost: () => false, isConnected: () => true }

function sidebarStore(): SidebarStoreHarness {
  const store = Object.create(SessionSidebarStore.prototype) as SidebarStoreHarness
  store.sessionHomes = ONE_HOME
  return store
}

function task(id: string, title: string): Task {
  return {
    id,
    providerId: 'local',
    projectKey: '/repo',
    title,
    body: '',
    status: 'todo',
    url: null,
    labels: [],
    updatedAt: 0,
  }
}

describe('session sidebar session rows', () => {
  test('projects a session under its owner, and under a referrer only where the user opened it', () => {
    // WHY: the host keeps one working owner per session. A referenced link is
    // a relationship the task page shows; drawing a row for it as well put the
    // same conversation under two tasks. An optimistic link written before the
    // host answered carries no role yet and is the owner by construction.
    const store = sidebarStore()
    store.session = {
      hasExplicitSidebarTaskSession: (taskId: string, sessionId: string) =>
        taskId === 'second-task' && sessionId === 'provider-session',
    }
    const owner = { sessionId: 'provider-session', role: 'working' as const }
    const optimistic = { sessionId: 'provider-session' }
    const reference = { sessionId: 'provider-session', role: 'referenced' as const }

    expect(store.projectsSessionUnder('first-task', owner)).toBe(true)
    expect(store.projectsSessionUnder('first-task', optimistic)).toBe(true)
    expect(store.projectsSessionUnder('unopened-task', reference)).toBe(false)
    expect(store.projectsSessionUnder('second-task', reference)).toBe(true)
  })

  test('the picker lists a task the sidebar has no row for, dismissals included', () => {
    // WHY: the sidebar column is this client's working set, so most pickable
    // tasks have no row in it. Reading their sessions through one reported them
    // as "no sessions yet" and then resumed one on ⏎. The picker restores a
    // dismissed row before it navigates, so it must count those too.
    const root = task('root', 'Ship the release')
    const store = sidebarStore()
    store.session = {
      tasksStore: {
        tasks: [root],
        get: () => ({
          serverId: 'workshop',
          sessions: [
            {
              taskId: root.id,
              sessionId: 'hidden',
              sessionTitle: 'Dismissed run',
              provider: 'claude',
              startedAt: 1,
              lastActivityAt: 1,
              executionServerId: null,
              // Owned elsewhere: the column projects nothing for a reference,
              // but restoring the task will reveal it, so the picker counts it.
              role: 'referenced',
              linkedAt: 1,
            },
          ],
        }),
      },
    }
    store.visibleTabIds = []
    store.pendingTabByTaskId = new Map()
    store.dismissedRowKeys = new Set([`session:hidden`])
    store.tabIdBySessionId = new Map()
    store.sessionsByTaskId = new Map()
    store.pickerSessionsByTaskId = new Map()
    store.session.hasExplicitSidebarTaskSession = () => false

    // The sidebar column, which owns dismissal, still hides it.
    expect(
      store.sessionsFor({ id: root.id, taskId: root.id, tabIds: [] } as unknown as SidebarTask),
    ).toEqual([])
    expect(store.sessionsForPickableTask(root).map((row) => row.sessionId)).toEqual(['hidden'])
  })

  test('a closed attempt reports the host it ran on, not the reader', () => {
    // WHY: the row states a machine unconditionally, so with no tab to ask it
    // used to assert "this machine" for every closed attempt — including a
    // session dispatched to another host, which is the one case where the mark
    // is the only thing that could have told you.
    const root = task('root', 'Ship the release')
    const store = sidebarStore()
    store.session = {
      tasksStore: {
        tasks: [root],
        // The task's own host answers for a link that recorded none: not a
        // dispatch means it ran wherever the task lives.
        get: () => ({
          serverId: 'workshop',
          sessions: [
            { taskId: root.id, sessionId: 'dispatched', sessionTitle: 'On Studio', provider: 'claude', startedAt: 2, lastActivityAt: 2, executionServerId: 'studio', linkedAt: 2 },
            { taskId: root.id, sessionId: 'here', sessionTitle: 'At home', provider: 'claude', startedAt: 1, lastActivityAt: 1, executionServerId: null, linkedAt: 1 },
          ],
        }),
      },
    }
    store.visibleTabIds = []
    store.pendingTabByTaskId = new Map()
    store.dismissedRowKeys = new Set()
    store.tabIdBySessionId = new Map()
    store.sessionsByTaskId = new Map()

    const rows = store.sessionsFor({ id: root.id, taskId: root.id, tabIds: [] } as unknown as SidebarTask)
    expect(rows.map((row) => [row.sessionId, row.serverId])).toEqual([
      ['here', 'workshop'],
      ['dispatched', 'studio'],
    ])
  })

  test('each attempt on a task carries its own name', () => {
    // WHY: a task holds as many sessions as it took attempts. Naming every one
    // of those rows after the task drew four identical rows for four
    // conversations, and renaming one of them appeared to rename all four —
    // the typed name went onto the session while the row read its task.
    const root = task('root', 'Ship the release')
    const store = sidebarStore()
    store.session = {
      tasksStore: {
        tasks: [root],
        get: () => ({
          serverId: 'workshop',
          sessions: [
            { taskId: root.id, sessionId: 'named', sessionTitle: 'lady', provider: 'claude', startedAt: 1, lastActivityAt: 1, executionServerId: null, linkedAt: 1 },
            // Nothing has named this one, so the task still speaks for it.
            { taskId: root.id, sessionId: 'unnamed', sessionTitle: null, provider: 'claude', startedAt: 2, lastActivityAt: 2, executionServerId: null, linkedAt: 2 },
          ],
        }),
      },
    }
    store.visibleTabIds = []
    store.pendingTabByTaskId = new Map()
    store.dismissedRowKeys = new Set()
    store.tabIdBySessionId = new Map()
    store.sessionsByTaskId = new Map()

    const rows = store.sessionsFor({ id: root.id, taskId: root.id, tabIds: [] } as unknown as SidebarTask)
    expect(rows.map((row) => [row.sessionId, row.label])).toEqual([
      ['named', 'lady'],
      ['unnamed', 'Ship the release'],
    ])
  })

  test('a restored tab with no hydrated messages keeps the durable activity time', () => {
    // WHY: restored tabs mount before their transcript arrives. Treating that
    // empty shell as the session's last activity produces "58y ago".
    const root = task('root', 'Ship the release')
    const store = sidebarStore()
    store.session = {
      tasksStore: {
        tasks: [root],
        get: () => ({
          serverId: 'workshop',
          sessions: [{
            taskId: root.id,
            sessionId: 'restored',
            sessionTitle: 'Restored run',
            provider: 'claude',
            startedAt: 100,
            lastActivityAt: 120,
            executionServerId: null,
            linkedAt: 110,
          }],
        }),
      },
    }
    store.pendingTabByTaskId = new Map()
    store.dismissedRowKeys = new Set()
    store.tabIdBySessionId = new Map([['restored', 'tab-1']])
    store.sessionsByTaskId = new Map()
    store.liveChildFor = () => ({
      tabId: 'tab-1',
      label: 'Restored run',
      attention: null,
      unread: false,
      serverId: 'workshop',
      branchName: null,
      runStartedAt: 0,
      reviewGuideStatus: null,
    })
    // The mounted transcript is still empty.
    store.tabActivityAt = () => 0

    const [row] = store.sessionsFor({
      id: root.id,
      taskId: root.id,
      tabIds: ['tab-1'],
    } as unknown as SidebarTask)
    expect(row.lastActivityAt).toBe(120)
  })
})
