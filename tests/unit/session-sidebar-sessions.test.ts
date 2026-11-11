import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import type { ListedSession } from '@solus/workspace-ui/contexts/workspace/session-list.store.svelte'
import { runGroupKey, SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import { projectsStore } from '@solus/workspace-ui/contexts/projects/projects.store.svelte'
import type { SessionHomeHosts } from '@solus/workspace-ui/components/session/lib/session-home'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

type SidebarStoreHarness = Pick<SessionSidebarStore, 'childForTab' | 'sessionsForPickableTask'> & {
  session: unknown
  tabIdBySessionId: Map<string, string>
  pickerSessionsByTaskId: Map<string, unknown>
  sessionHomes: SessionHomeHosts
  lifecycleNow: number
  liveChildFor(tabId: string): Omit<ReturnType<SessionSidebarStore['childForTab']>, 'lastActivityAt'>
  tabActivityAt(tabId: string): number
  buildListedSessionRow(listed: ListedSession): SidebarTask
}

/** No cloud host and every runner up: the rows merge to themselves (session-home.ts). */
const ONE_HOME: SessionHomeHosts = { isSolusApi: () => false, isConnected: () => true }

function sidebarStore(): SidebarStoreHarness {
  const store = Object.create(SessionSidebarStore.prototype) as SidebarStoreHarness
  store.sessionHomes = ONE_HOME
  store.tabIdBySessionId = new Map()
  store.pickerSessionsByTaskId = new Map()
  return store
}

function task(id: string, title: string): Task {
  return {
    id,
    providerId: 'github',
    kind: 'issue',
    title,
    body: '',
    url: null,
    state: { name: 'Open', category: 'open' },
    category: 'open',
    placements: [],
    labels: [],
    writableFields: [],
    updatedAt: 0,
  }
}

describe('session sidebar session rows', () => {
  test('a session linked to a task has its own row, and the row names the task', () => {
    // WHY: tasks have no place in the sidebar. A session linked to a task is
    // still one row of its own; the chip on it is the way to the task page.
    const root = task('root', 'Ship the release')
    const store = sidebarStore()
    store.lifecycleNow = 10
    store.session = {
      tasksStore: { taskForSession: (sessionId: string) => (sessionId === 'linked' ? root : null) },
    }
    const listed = (sessionId: string) => ({
      sessionId, serverId: 'workshop', title: sessionId, projectPath: '/repo', createdAt: 1,
    }) as ListedSession

    const row = store.buildListedSessionRow(listed('linked'))
    expect(row).toMatchObject({ id: 'session:linked', sessionId: 'linked', title: 'linked' })
    expect(row.linkedTask).toEqual({ taskId: 'root', title: 'Ship the release' })
    expect('taskId' in row).toBe(false)
    expect(store.buildListedSessionRow(listed('loose')).linkedTask).toBeUndefined()
  })

  test('the picker lists every session linked to a task, owned or referenced', () => {
    // WHY: the picker reads a task's own links, not a sidebar row: no task has
    // a row. Reading them through one reported "no sessions yet" and then
    // resumed one on ⏎.
    const root = task('root', 'Ship the release')
    const store = sidebarStore()
    store.session = {
      tasksStore: {
        tasks: [root],
        get: () => ({
          serverId: 'workshop',
          sessions: [
            { taskId: root.id, sessionId: 'owned', sessionTitle: 'Owned run', provider: 'claude', startedAt: 1, lastActivityAt: 1, executionServerId: null, role: 'working', linkedAt: 1 },
            { taskId: root.id, sessionId: 'referenced', sessionTitle: 'Referenced run', provider: 'claude', startedAt: 2, lastActivityAt: 2, executionServerId: null, role: 'referenced', linkedAt: 2 },
          ],
        }),
      },
    }

    expect(store.sessionsForPickableTask(root).map((row) => row.sessionId)).toEqual(['owned', 'referenced'])
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

    const rows = store.sessionsForPickableTask(root)
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

    const rows = store.sessionsForPickableTask(root)
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
    store.tabIdBySessionId = new Map([['restored', 'tab-1']])
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

    const [row] = store.sessionsForPickableTask(root)
    expect(row.lastActivityAt).toBe(120)
  })
})

describe('the project of a dispatched session', () => {
  test('is read on the host its project path is on, not on the host its agent runs on', async () => {
    // WHY: a session sent to another host keeps its project's path on the host
    // it was opened from. Read on the agent's host, that path named a project
    // of its own there: the row left its project's group, and its favicon was
    // looked up on a host that does not have the folder.
    await projectsStore.loadProjectsFor('dispatch-laptop', {
      listProjects: async () => [{
        key: '/Users/me/web', path: '/Users/me/web', folderName: 'web',
        addedAt: '2026-09-01T12:00:00Z', lastUsedAt: '2026-09-04T12:00:00Z', repositoryKey: 'github.com/acme/web',
      }],
    }, { force: true })

    const dispatched = {
      location: folderLocation(
        { serverId: 'dispatch-box', path: '/srv/web' },
        { project: { serverId: 'dispatch-laptop', path: '/Users/me/web' } },
      ),
    }
    expect(runGroupKey(dispatched, '/Users/me/web')).toBe('github.com/acme/web')
    expect(projectsStore.checkoutFor(runGroupKey(dispatched, '/Users/me/web')))
      .toEqual({ serverId: 'dispatch-laptop', projectRoot: '/Users/me/web' })

    // A run that was not dispatched reads its folder on its own host.
    const local = { location: folderLocation({ serverId: 'dispatch-box', path: '/home/me/notes' }) }
    expect(runGroupKey(local, '/home/me/notes')).toBe('dispatch-box:/home/me/notes')
  })
})

describe('the drawer of sessions a row started', () => {
  type FoldHarness = Pick<SessionSidebarStore, 'isNestedOpen' | 'setNestedOpen' | 'toggleNestedSessions'> & {
    onScreenRowId: string | null
  }
  function foldStore(onScreenRowId: string | null): FoldHarness {
    const store = Object.create(SessionSidebarStore.prototype) as FoldHarness
    store.onScreenRowId = onScreenRowId
    return store
  }
  // SAFETY: the fold reads only a row's id.
  const lead = { id: 'lead' } as SidebarTask
  const other = { id: 'other' } as SidebarTask

  test('opens under the row on the path to the conversation on screen, and under no other', () => {
    // WHY: the sessions a row started matter while the person is in that
    // work. Clicking into another session closes the drawer, so the column
    // does not keep every tree open at once.
    const store = foldStore('lead')
    expect(store.isNestedOpen(lead)).toBe(true)
    expect(store.isNestedOpen(other)).toBe(false)
  })

  test('a fold by hand holds while the person reads, and ends when they click away', () => {
    const store = foldStore('lead')
    store.toggleNestedSessions(lead)
    expect(store.isNestedOpen(lead)).toBe(false)
    store.onScreenRowId = 'other'
    expect(store.isNestedOpen(lead)).toBe(false)
    // A click on the row opens its session and its drawer, whatever was folded.
    store.onScreenRowId = 'lead'
    store.setNestedOpen(lead, true)
    expect(store.isNestedOpen(lead)).toBe(true)
  })

  test('a row off the path can be opened by hand, until the conversation changes', () => {
    const store = foldStore('lead')
    store.setNestedOpen(other, true)
    expect(store.isNestedOpen(other)).toBe(true)
    store.onScreenRowId = 'third'
    expect(store.isNestedOpen(other)).toBe(false)
  })
})
