import { afterEach, describe, expect, jest, mock, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import type { HostPhase } from '@solus/client-core/host-supervisor'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const taskServerConnections = singleHostServerConnections()
let connectionCreatedListener: ((connection: { serverId: string }) => void) | undefined
let phaseChangeListener: ((serverId: string, phase: HostPhase) => void) | undefined
const hostPhases = new Map<string, HostPhase>()

// One connected host, whose RPC surface is the same `window.solus` each test
// installs. Tasks are host-scoped now, so the store reaches them through the
// connection registry rather than the global — the single-host case has to keep
// behaving exactly as it did.
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    ...taskServerConnections,
    onConnectionCreated: (listener: (connection: { serverId: string }) => void) => {
      connectionCreatedListener = listener
      return () => {
        if (connectionCreatedListener === listener) connectionCreatedListener = undefined
      }
    },
    onPhaseChange: (listener: (serverId: string, phase: HostPhase) => void) => {
      phaseChangeListener = listener
      return () => {
        if (phaseChangeListener === listener) phaseChangeListener = undefined
      }
    },
    phaseFor: (serverId: string) => hostPhases.get(serverId) ?? 'connected',
  },
}))

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousDerived = (globalThis as unknown as { $derived?: unknown }).$derived
const previousEffect = (globalThis as unknown as { $effect?: unknown }).$effect

afterEach(() => {
  jest.useRealTimers()
  taskServerConnections.reset()
  connectionCreatedListener = undefined
  phaseChangeListener = undefined
  hostPhases.clear()
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousDerived === undefined) delete (globalThis as unknown as { $derived?: unknown }).$derived
  else (globalThis as unknown as { $derived: unknown }).$derived = previousDerived
  if (previousEffect === undefined) delete (globalThis as unknown as { $effect?: unknown }).$effect
  else (globalThis as unknown as { $effect: unknown }).$effect = previousEffect
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
  ;(globalThis as unknown as { $effect: unknown }).$effect = (effect: () => void) => effect()
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
  test('rejects an authoritative session read when the task host is unavailable', async () => {
    // WHY: turn settlement mints a fallback task only after this read. Treating
    // an RPC failure as an empty result can duplicate a task linked by the agent.
    installStateRune()
    const api = {
      tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
      tasksForSession: async () => {
        throw new Error('task host unavailable')
      },
    }
    taskServerConnections.registerPrimary('local', api)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: api },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()

    await expect(store.findSessionTaskOnHost(['session-1'], 'local'))
      .rejects.toThrow('task host unavailable')
  })

  test('refreshes visible task details without fanning out through the hidden cache', async () => {
    // WHY: Editor and Pill keep hidden tabs mounted. A task invalidation must not
    // turn every task detail ever opened in those tabs into a simultaneous RPC.
    jest.useFakeTimers()
    installStateRune()
    const detailReads: string[] = []
    const api = {
      tasksSidebarSnapshot: async () => ({
        tasks: [
          { ...task(), id: 'visible' },
          { ...task(), id: 'hidden' },
        ],
        sessionsByTask: {},
      }),
      tasksGet: async (taskId: string) => {
        detailReads.push(taskId)
        return {
          task: { ...task(), id: taskId },
          comments: [],
          events: [],
          links: [],
          subtasks: [],
        }
      },
    }
    taskServerConnections.registerPrimary('local', api)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: api },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()
    await store.loadDetails('visible')
    await store.loadDetails('hidden')
    detailReads.splice(0)

    const stopWatching = store.watchDetails('visible')
    taskServerConnections.emit('local', 'tasks.invalidated', {})
    jest.advanceTimersByTime(101)
    await Promise.resolve()
    await Promise.resolve()

    expect(detailReads).toEqual(['visible'])
    stopWatching()
  })

  test('coalesces detail reads for the same task', async () => {
    // WHY: the visible task page and its project rail can ask for the same detail
    // on one frame. They must share the RPC rather than racing duplicate reads.
    installStateRune()
    let detailReads = 0
    let resolveDetails!: (value: {
      task: Task
      comments: []
      events: []
      links: []
      subtasks: []
    }) => void
    const details = new Promise<{
      task: Task
      comments: []
      events: []
      links: []
      subtasks: []
    }>((resolve) => { resolveDetails = resolve })
    const api = {
      tasksSidebarSnapshot: async () => ({ tasks: [task()], sessionsByTask: {} }),
      tasksGet: () => {
        detailReads++
        return details
      },
    }
    taskServerConnections.registerPrimary('local', api)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: api },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()
    const first = store.loadDetails('task-1')
    const second = store.loadDetails('task-1')

    expect(first).toBe(second)
    expect(detailReads).toBe(1)
    resolveDetails({ task: task(), comments: [], events: [], links: [], subtasks: [] })
    await first
  })

  test('reloads after a host is restored during the cold snapshot', async () => {
    // WHY: restored tabs can create their host connection while the first task
    // read is in flight. The completed lifecycle on that host must reach the
    // first stable sidebar instead of waiting for later typing or task activity.
    installStateRune()
    let resolveLocalSnapshot!: (result: {
      tasks: Task[]
      sessionsByTask: Record<string, Array<{ taskId: string; sessionId: string; linkedAt: number }>>
    }) => void
    const localSnapshot = new Promise<{
      tasks: Task[]
      sessionsByTask: Record<string, Array<{ taskId: string; sessionId: string; linkedAt: number }>>
    }>((resolve) => {
      resolveLocalSnapshot = resolve
    })
    const localApi = { tasksSidebarSnapshot: () => localSnapshot }
    let resolveRemoteSnapshot!: (result: {
      tasks: Task[]
      sessionsByTask: Record<string, Array<{ taskId: string; sessionId: string; linkedAt: number }>>
    }) => void
    const remoteSnapshot = new Promise<{
      tasks: Task[]
      sessionsByTask: Record<string, Array<{ taskId: string; sessionId: string; linkedAt: number }>>
    }>((resolve) => {
      resolveRemoteSnapshot = resolve
    })
    const remoteTask = { ...task(), id: 'remote-completed', status: 'done' as const }
    const remoteApi = {
      tasksSidebarSnapshot: () => remoteSnapshot,
    }
    taskServerConnections.registerPrimary('local', localApi)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: localApi },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    const firstLoad = store.ensureLoaded()
    await Promise.resolve()

    const remoteConnection = taskServerConnections.registerHost('remote', remoteApi)
    connectionCreatedListener?.(remoteConnection)
    resolveLocalSnapshot({ tasks: [], sessionsByTask: {} })
    await Promise.resolve()

    expect(store.loaded).toBe(false)
    expect(store.tasks).toEqual([])

    resolveRemoteSnapshot({
      tasks: [remoteTask],
      sessionsByTask: {
        'remote-completed': [{
          taskId: 'remote-completed',
          sessionId: 'restored-session',
          linkedAt: 1,
        }],
      },
    })
    await firstLoad

    expect(store.taskForSession('restored-session')?.status).toBe('done')
    expect(store.hostFor('remote-completed')).toBe('remote')
  })

  test('does not let an offline host block healthy sidebar sessions', async () => {
    // WHY: saved hosts are supervised before their first successful socket.
    // An unreachable host's RPC queue must not keep the local task snapshot in
    // the loading state, or every session row disappears from the sidebar.
    installStateRune()
    const localTask = { ...task(), id: 'local-task' }
    const remoteTask = { ...task(), id: 'remote-task' }
    const localApi = {
      tasksSidebarSnapshot: async () => ({
        tasks: [localTask],
        sessionsByTask: {
          'local-task': [{ taskId: 'local-task', sessionId: 'local-session', linkedAt: 1 }],
        },
      }),
    }
    let resolveRemoteSnapshot!: (snapshot: {
      tasks: Task[]
      sessionsByTask: Record<string, Array<{ taskId: string; sessionId: string; linkedAt: number }>>
    }) => void
    const remoteSnapshot = new Promise<{
      tasks: Task[]
      sessionsByTask: Record<string, Array<{ taskId: string; sessionId: string; linkedAt: number }>>
    }>((resolve) => {
      resolveRemoteSnapshot = resolve
    })
    let remoteReads = 0
    const remoteApi = {
      tasksSidebarSnapshot: () => {
        remoteReads++
        return remoteSnapshot
      },
    }
    taskServerConnections.registerPrimary('local', localApi)
    taskServerConnections.registerHost('remote', remoteApi)
    hostPhases.set('remote', 'offline')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: localApi },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    expect(store.loaded).toBe(true)
    expect(store.taskForSession('local-session')?.id).toBe('local-task')
    expect(remoteReads).toBe(0)

    hostPhases.set('remote', 'connected')
    phaseChangeListener?.('remote', 'connected')
    const connectedLoad = store.load()
    resolveRemoteSnapshot({
      tasks: [remoteTask],
      sessionsByTask: {
        'remote-task': [{ taskId: 'remote-task', sessionId: 'remote-session', linkedAt: 2 }],
      },
    })
    await connectedLoad

    expect(store.taskForSession('remote-session')?.id).toBe('remote-task')
    expect(remoteReads).toBe(1)
  })

  test('lists a task once when two hosts serve the same task store', async () => {
    // WHY: a desktop host and a standalone server can front the same data
    // directory, so both report the same ULIDs. The sidebar keys its rows by
    // task id — a second copy breaks the whole keyed block, and routes the
    // task's writes to whichever host answered last.
    installStateRune()
    const shared = { ...task(), id: 'shared-task' }
    const primaryApi = {
      tasksSidebarSnapshot: async () => ({
        tasks: [shared],
        sessionsByTask: { 'shared-task': [{ taskId: 'shared-task', sessionId: 'primary-session', linkedAt: 1 }] },
      }),
    }
    const mirrorApi = {
      tasksSidebarSnapshot: async () => ({
        tasks: [shared],
        sessionsByTask: { 'shared-task': [{ taskId: 'shared-task', sessionId: 'mirror-session', linkedAt: 2 }] },
      }),
    }
    taskServerConnections.registerPrimary('local', primaryApi)
    taskServerConnections.registerHost('mirror', mirrorApi)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: primaryApi },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    expect(store.tasks.map((entry) => entry.id)).toEqual(['shared-task'])
    expect(store.hostFor('shared-task')).toBe('local')
    expect(store.sessionsByTask.get('shared-task')?.map((link) => link.sessionId)).toEqual(['primary-session'])
  })

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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
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
        parent: [{ taskId: 'parent', sessionId: 'resumed-session', role: 'referenced', linkedAt: 0 }],
        child: [{ taskId: 'child', sessionId: 'resumed-session', linkedAt: 1 }],
      },
    })
    await hydration

    expect(store.taskForSession('resumed-session')?.id).toBe('child')
    expect(store.tasks.map(({ id }) => id).sort()).toEqual(['child', 'parent'])
    expect(store.attemptsForTask('parent').map(({ sessionId }) => sessionId)).toEqual([
      'resumed-session',
    ])
    expect(store.attemptsForTask('child').map(({ sessionId }) => sessionId)).toEqual([
      'resumed-session',
    ])
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    store.trackSessionStart('task-1', 'session-1')
    store.trackSessionStart('task-1', 'session-1')

    expect(store.sessionsByTask.get('task-1')).toEqual([
      expect.objectContaining({ taskId: 'task-1', sessionId: 'session-1' }),
    ])
    expect(store.taskForSession('session-1')?.id).toBe('task-1')
  })

  test('re-keys a provider attempt to one stable handoff session', async () => {
    // WHY: the sidebar reads this store in the same frame as a provider switch.
    // Keeping the old attempt while adding the stable id creates two rows.
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()
    store.trackSessionStart('task-1', 'provider-session')

    store.rekeySessionBinding('provider-session', 'solus-session')

    expect(store.taskForSession('provider-session')).toBeNull()
    expect(store.taskForSession('solus-session')?.id).toBe('task-1')
    expect(store.sessionsByTask.get('task-1')?.map((attempt) => attempt.sessionId)).toEqual([
      'solus-session',
    ])
  })

  test('forwards a dispatched handoff re-key to the task host', async () => {
    // WHY: the provider switch runs on the execution host, but a dispatched
    // session's attempt row lives on the task host. Updating only renderer state
    // leaves the old provider attempt durable and it returns as a duplicate row.
    installStateRune()
    const rekeys: Array<[string, string]> = []
    const api = {
      tasksSidebarSnapshot: async () => ({ tasks: [task()], sessionsByTask: {} }),
      tasksRekeySession: async (sourceSessionId: string, targetSessionId: string) => {
        rekeys.push([sourceSessionId, targetSessionId])
      },
      tasksForSession: async () => null,
    }
    taskServerConnections.registerPrimary('task-host', api)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: api },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()
    store.trackSessionStart('task-1', 'provider-session')

    store.rekeySessionBinding('provider-session', 'solus-session', 'task-host')
    await Promise.resolve()

    expect(rekeys).toEqual([['provider-session', 'solus-session']])
    expect(store.taskForSession('provider-session')).toBeNull()
    expect(store.taskForSession('solus-session')?.id).toBe('task-1')
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
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

  test('keeps a task hidden when a refresh lands during its undo window', async () => {
    // WHY: deletion is deferred so the user can undo it. Until that window
    // closes, the durable row still exists and an unrelated invalidation can
    // refresh it from the host. That refresh must not resurrect the task.
    installStateRune()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({ tasks: [task()], sessionsByTask: {} }),
          tasksGet: async () => ({
            task: task(),
            comments: [],
            events: [],
            links: [],
            subtasks: [],
          }),
        },
      },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    const pending = store.softRemove(['task-1'])
    expect(pending).toHaveLength(1)
    await store.load()
    await store.loadDetails('task-1')

    expect(store.tasks).toEqual([])

    store.restorePending(pending)
    expect(store.tasks.map(({ id }) => id)).toEqual(['task-1'])
  })

  test('bounds concurrent RPCs when a large task deletion commits', async () => {
    // WHY: one RPC per selected task can exceed the transport's in-flight
    // request limit. A large selection must drain through a small worker pool.
    installStateRune()
    const tasks = Array.from({ length: 105 }, (_, index) => ({
      ...task(),
      id: `task-${index + 1}`,
    }))
    let activeDeletes = 0
    let maximumActiveDeletes = 0
    const deletedIds: string[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({ tasks, sessionsByTask: {} }),
          tasksDelete: async (taskId: string) => {
            activeDeletes++
            maximumActiveDeletes = Math.max(maximumActiveDeletes, activeDeletes)
            await Promise.resolve()
            deletedIds.push(taskId)
            activeDeletes--
          },
        },
      },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()
    const pending = store.softRemove(tasks.map(({ id }) => id))

    await store.commitPending(pending)

    expect(deletedIds).toHaveLength(105)
    expect(new Set(deletedIds).size).toBe(105)
    expect(maximumActiveDeletes).toBeLessThanOrEqual(8)
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
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

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    const details = await store.loadDetails(issue.id, projectKey)

    expect(details.task.id).toBe('87')
    expect(store.taskForId('87', projectKey)?.providerId).toBe('github')
    expect(upstreamGets).toBe(1)
  })
})
