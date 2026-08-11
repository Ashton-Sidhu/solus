import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Task } from '../../src/shared/task-types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

// One connected host, whose RPC surface is the same `window.solus` each test
// installs. Tasks are host-scoped now, so the store reaches them through the
// connection registry rather than the global — the single-host case has to keep
// behaving exactly as it did.
mock.module('@client-core/server-connections', () => ({
  serverConnections: {
    ...singleHostServerConnections(),
    eventsFor: () => ({ subscribe: () => () => {} }),
    onConnectionCreated: () => () => {},
    connectedServerIds: () => ['local'],
  },
}))

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousDerived = (globalThis as unknown as { $derived?: unknown }).$derived

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousDerived === undefined) delete (globalThis as unknown as { $derived?: unknown }).$derived
  else (globalThis as unknown as { $derived: unknown }).$derived = previousDerived
})

function installStateRune(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  ;(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
    <T>(value: T) => value,
    { by: <T>(derive: () => T) => derive() },
  )
}

function task(): Task {
  return {
    id: 'task-1',
    providerId: 'local',
    kind: 'task',
    title: 'Hydrated task',
    body: '',
    status: 'in_progress',
    url: null,
    labels: [],
    updatedAt: 0,
  }
}

describe('renderer task hydration', () => {
  test('publishes task rows and session ownership as one sidebar snapshot', async () => {
    // WHY: restored sessions must never render between independently timed task
    // and link reads. The host response is the renderer's atomic boundary.
    installStateRune()
    let resolveSnapshot!: (result: {
      tasks: Task[]
      sessionsByTask: Record<string, Array<{ taskId: string; sessionId: string; linkedAt: number }>>
    }) => void
    const snapshot = new Promise<{
      tasks: Task[]
      sessionsByTask: Record<string, Array<{ taskId: string; sessionId: string; linkedAt: number }>>
    }>((resolve) => {
      resolveSnapshot = resolve
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: () => snapshot,
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    const hydration = store.ensureLoaded()
    await Promise.resolve()

    expect(store.tasks).toEqual([])
    expect(store.taskForSession('resumed-session')).toBeNull()

    resolveSnapshot({
      tasks: [
        { ...task(), id: 'parent' },
        { ...task(), id: 'child', parentId: 'parent' },
      ],
      sessionsByTask: {
        child: [{ taskId: 'child', sessionId: 'resumed-session', linkedAt: 1 }],
      },
    })
    await hydration

    expect(store.taskForSession('resumed-session')?.id).toBe('child')
    expect(store.tasks.map(({ id }) => id).sort()).toEqual(['child', 'parent'])
  })

  test('restores a durable PR link from the cold-start sidebar snapshot', async () => {
    // WHY: the PR list is renderer memory and starts empty after refresh. A
    // linked PR must still render before branch discovery runs again.
    installStateRune()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({
            tasks: [task()],
            sessionsByTask: {},
            prLinksByTask: {
              'task-1': { number: 43, url: 'https://github.com/openai/solus/pull/43' },
            },
          }),
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    expect(store.prLinkFor('task-1')).toEqual({
      number: 43,
      url: 'https://github.com/openai/solus/pull/43',
    })
  })

  test('refreshes the authoritative snapshot when an opened session binding is missing', async () => {
    // WHY: a session may be opened after another actor created its task link.
    // One missing-binding refresh recovers it without renderer-side tree merges.
    installStateRune()
    const parent = { ...task(), id: 'parent', title: 'Parent task' }
    const child = { ...task(), id: 'child', parentId: 'parent', title: 'Current subtask' }
    let calls = 0
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksForSession: async () => null,
          tasksSidebarSnapshot: async () => calls++ === 0
            ? { tasks: [], sessionsByTask: {} }
            : {
                tasks: [parent, child],
                sessionsByTask: {
                  child: [{ taskId: 'child', sessionId: 'resumed-session', linkedAt: 1 }],
                },
              },
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureSessionBinding('resumed-session')

    expect(store.taskForSession('resumed-session')?.id).toBe('child')
    expect(store.tasks.map(({ id }) => id).sort()).toEqual(['child', 'parent'])
    expect(calls).toBe(2)
  })

  test('hydrates the complete related tree when the snapshot already knows the selected session', async () => {
    // WHY: opening from the session picker must not stop at the first known
    // task binding. Sibling subtasks and their named session links are cheap
    // metadata and must appear before any sibling transcript is opened.
    installStateRune()
    const parent = { ...task(), id: 'parent', title: 'Parent task' }
    const selected = { ...task(), id: 'selected', parentId: parent.id, title: 'Selected subtask' }
    const sibling = { ...task(), id: 'sibling', parentId: parent.id, title: 'Named sibling' }
    let treeReads = 0
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({
            tasks: [selected],
            sessionsByTask: {
              selected: [{ taskId: selected.id, sessionId: 'selected-session', linkedAt: 1 }],
            },
          }),
          tasksForSession: async () => {
            treeReads++
            return {
              task: selected,
              parent,
              subtasks: [selected, sibling],
              siblings: [sibling],
              attempts: [
                {
                  taskId: selected.id,
                  sessionId: 'selected-session',
                  sessionTitle: 'Selected session',
                  linkedAt: 1,
                },
                {
                  taskId: sibling.id,
                  sessionId: 'sibling-session',
                  sessionTitle: 'Named sibling session',
                  linkedAt: 2,
                },
              ],
            }
          },
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureSessionBinding('selected-session')

    expect(treeReads).toBe(1)
    expect(store.tasks.map(({ id }) => id).sort()).toEqual(['parent', 'selected', 'sibling'])
    expect(store.sessionsByTask.get('sibling')).toEqual([
      expect.objectContaining({
        sessionId: 'sibling-session',
        sessionTitle: 'Named sibling session',
      }),
    ])
    expect(store.taskForSession('sibling-session')?.title).toBe('Named sibling')
  })

  test('publishes a started session before durable link hydration settles', async () => {
    // WHY: Tasks-page rows derive their running state from sessionsByTask. A
    // session that just initialized must appear there on the same frame rather
    // than leaving the row idle until a follow-up RPC completes.
    installStateRune()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({ tasks: [task()], sessionsByTask: {} }),
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    store.trackSessionStart('task-1', 'session-1')
    store.trackSessionStart('task-1', 'session-1')

    expect(store.sessionsByTask.get('task-1')).toEqual([
      expect.objectContaining({ taskId: 'task-1', sessionId: 'session-1' }),
    ])
    expect(store.taskForSession('session-1')?.id).toBe('task-1')
  })

  test('keeps GitHub issue sync loading until the upstream request settles', async () => {
    // WHY: the Tasks header spinner must describe the GitHub sync itself, not
    // just the much faster local task read that runs beside it.
    installStateRune()
    const projectKey = '/workspace/solus'
    let upstreamCalls = 0
    let resolveUpstream!: (result: { tasks: Task[] }) => void
    const upstream = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveUpstream = resolve
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
          tasksListUpstream: () => {
            upstreamCalls++
            return upstream
          },
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    const firstSync = store.loadUpstream(projectKey, { refresh: true })
    const duplicateSync = store.loadUpstream(projectKey, { refresh: true })

    expect(store.upstreamLoadingByProject.get(projectKey)).toBe(true)
    expect(upstreamCalls).toBe(1)
    resolveUpstream({ tasks: [] })
    await Promise.all([firstSync, duplicateSync])

    expect(store.upstreamLoadingByProject.has(projectKey)).toBe(false)
  })

  test('preserves GitHub issue freshness metadata without treating a live read as stale', async () => {
    // WHY: the old sync UX showed a quiet "updated" fact after a live read;
    // only an actual offline fallback should be labelled as a cached copy.
    installStateRune()
    const projectKey = '/workspace/solus'
    const fetchedAt = 1_785_000_000_000
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
          tasksListUpstream: async () => ({ tasks: [], fetchedAt }),
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.loadUpstream(projectKey)

    expect(store.upstreamRefreshedAtByProject.get(projectKey)).toBe(fetchedAt)
    expect(store.upstreamFromCacheByProject.has(projectKey)).toBe(false)
  })

  test('does not publish the initial snapshot before task-session links settle', async () => {
    // WHY: restored tabs render on the first frame. If task records become
    // "loaded" before their links, the sidebar briefly classifies every restored
    // session as an unrelated loose task and then redraws the whole list.
    installStateRune()
    let resolveSnapshot!: (snapshot: { tasks: Task[]; sessionsByTask: Record<string, unknown[]> }) => void
    const snapshot = new Promise<{ tasks: Task[]; sessionsByTask: Record<string, unknown[]> }>((resolve) => {
      resolveSnapshot = resolve
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: () => snapshot,
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    const hydration = store.ensureLoaded()
    await Promise.resolve()
    await Promise.resolve()

    expect(store.tasks).toHaveLength(0)
    expect(store.loaded).toBe(false)
    expect(store.taskForSession('session-1')).toBeNull()

    resolveSnapshot({
      tasks: [task()],
      sessionsByTask: {
        'task-1': [{ taskId: 'task-1', sessionId: 'session-1', linkedAt: 1 }],
      },
    })
    await hydration

    expect(store.loaded).toBe(true)
    expect(store.tasks).toHaveLength(1)
    expect(store.taskForSession('session-1')?.id).toBe('task-1')
  })

  test('keeps a refresh snapshot hidden until its task-session links settle', async () => {
    // WHY: session-born task creation invalidates an already-loaded store. If
    // the new task row publishes before its link, the sidebar shows both the
    // durable task and the loose session until the link request completes.
    installStateRune()
    let snapshotRequest = 0
    let resolveRefreshSnapshot!: (snapshot: { tasks: Task[]; sessionsByTask: Record<string, unknown[]> }) => void
    const refreshSnapshot = new Promise<{ tasks: Task[]; sessionsByTask: Record<string, unknown[]> }>((resolve) => {
      resolveRefreshSnapshot = resolve
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: () => snapshotRequest++ === 0
            ? Promise.resolve({ tasks: [], sessionsByTask: {} })
            : refreshSnapshot,
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    const refresh = store.load()
    await Promise.resolve()
    await Promise.resolve()

    expect(store.tasks).toHaveLength(0)
    expect(store.taskForSession('session-1')).toBeNull()

    resolveRefreshSnapshot({
      tasks: [task()],
      sessionsByTask: {
        'task-1': [{ taskId: 'task-1', sessionId: 'session-1', linkedAt: 1 }],
      },
    })
    await refresh

    expect(store.tasks).toHaveLength(1)
    expect(store.taskForSession('session-1')?.id).toBe('task-1')
  })

  test('publishes a newly posted GitHub comment into open task details', async () => {
    // WHY: posting upstream can replace the issue row successfully while the
    // open activity feed still points at its earlier hydrated detail snapshot.
    installStateRune()
    const projectKey = '/workspace/solus'
    const issue: Task = {
      id: '31',
      providerId: 'github',
      projectKey,
      kind: 'task',
      title: 'GitHub issue',
      body: '',
      status: 'todo',
      url: 'https://github.com/example/solus/issues/31',
      labels: [],
      updatedAt: 1_785_000_000_000,
      raw: { comments: [] },
    }
    const commented = {
      ...issue,
      raw: {
        comments: [{
          id: 'comment-1',
          author: { login: 'octocat' },
          body: 'Posted from Solus',
          createdAt: '2026-08-04T12:30:00Z',
        }],
      },
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
          tasksListUpstream: async () => ({ tasks: [issue] }),
          tasksGetUpstream: async () => issue,
          tasksCommentUpstream: async () => commented,
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.load()
    await store.loadUpstream(projectKey)
    await store.loadDetails(issue.id, projectKey)
    await store.comment(issue.id, 'Posted from Solus')

    expect(store.detailsFor(issue.id)?.comments).toEqual([
      expect.objectContaining({ body: 'Posted from Solus', author: 'octocat' }),
    ])
  })

  test('hydrates a directly opened GitHub issue even when it is absent from the list snapshot', async () => {
    // WHY: a single-item route must reach the cache-first upstream lookup rather
    // than being misclassified as a missing native Solus task.
    installStateRune()
    const projectKey = '/workspace/solus'
    const issue: Task = {
      id: '87',
      providerId: 'github',
      projectKey,
      kind: 'task',
      title: 'Direct issue',
      body: '',
      status: 'todo',
      url: 'https://github.com/example/solus/issues/87',
      labels: [],
      updatedAt: 1_785_000_000_000,
    }
    let upstreamGets = 0
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
          tasksProviderStatus: async () => ({
            provider: 'github',
            ok: true,
            reason: 'ok',
            message: 'Connected',
          }),
          tasksGetUpstream: async () => {
            upstreamGets++
            return issue
          },
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    const details = await store.loadDetails(issue.id, projectKey)

    expect(details.task.id).toBe('87')
    expect(store.taskForId('87', projectKey)?.providerId).toBe('github')
    expect(upstreamGets).toBe(1)
  })
})
