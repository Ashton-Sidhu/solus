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
  test('loads task assignees lazily and reuses the project result', async () => {
    // WHY: repositories can have many assignable users. Opening a task must
    // not fetch them until the user opens the assignee menu.
    installStateRune()
    let calls = 0
    const api = {
      tasksSidebarSnapshot: async () => ({ tasks: [task()], sessionsByTask: {} }),
      tasksListAssigneeCandidates: async () => {
        calls++
        return [{ login: 'octocat', avatarUrl: 'https://avatars.test/octocat' }]
      },
    }
    taskServerConnections.registerPrimary('local', api)
    Object.defineProperty(globalThis, 'window', {
      configurable: true, writable: true, value: { solus: api },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    expect(calls).toBe(0)
    await store.loadAssigneeCandidates('/workspace/solus', { serverId: 'local' })
    await store.loadAssigneeCandidates('/workspace/solus', { serverId: 'local' })

    expect(calls).toBe(1)
    expect(store.assigneeCandidates('/workspace/solus')).toEqual([
      { login: 'octocat', avatarUrl: 'https://avatars.test/octocat' },
    ])
  })

  test('only the working link answers for a session, whatever order the snapshot lists it', async () => {
    // WHY: a task that merely references a session lists it, but does not own
    // it. Letting that link claim the session sent the next prompt, and its
    // sidebar row, to the referrer instead of the task the work belongs to.
    installStateRune()
    const link = (taskId: string, role: 'working' | 'referenced') => ({
      taskId,
      sessionId: 'shared-session',
      sessionTitle: 'Shared run',
      provider: 'claude',
      startedAt: 1,
      lastActivityAt: 1,
      role,
      linkedAt: role === 'referenced' ? 2 : 1,
    })
    const api = {
      tasksSidebarSnapshot: async () => ({
        tasks: [{ ...task(), id: 'referrer' }, { ...task(), id: 'owner' }],
        sessionsByTask: {
          referrer: [link('referrer', 'referenced')],
          owner: [link('owner', 'working')],
        },
      }),
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

    expect(store.taskForSession('shared-session')?.id).toBe('owner')
    expect(store.get('referrer').sessions.map((attempt) => attempt.sessionId)).toEqual(['shared-session'])
  })

  test('serves one task object per id, so a detail read reaches every holder', async () => {
    // WHY: what a task knows used to be spread across a map per fact, keyed by
    // id. A surface holding one of those maps could render a task the rest of
    // the workspace had already moved past. One object per id is what makes that
    // impossible — a reference taken before a read sees the result of it.
    installStateRune()
    const api = {
      tasksSidebarSnapshot: async () => ({ tasks: [task()], sessionsByTask: {} }),
      tasksGet: async () => ({
        task: { ...task(), title: 'Read from the host' },
        comments: [{ id: 'comment-1', body: 'Landed' }],
        events: [],
        links: [],
        subtasks: [],
      }),
    }
    taskServerConnections.registerPrimary('local', api)
    Object.defineProperty(globalThis, 'window', {
      configurable: true, writable: true, value: { solus: api },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    const heldBeforeTheRead = store.get('task-1')
    expect(store.get('task-1')).toBe(heldBeforeTheRead)

    await store.get('task-1').loadDetails()

    expect(heldBeforeTheRead.details?.comments).toHaveLength(1)
    expect(heldBeforeTheRead.title).toBe('Read from the host')
  })

  test('lists the task itself, so an optimistic write redraws its row', async () => {
    // WHY: the list is membership, not a second copy. A status written through
    // the task has to be the status the sidebar row reads — holding a separate
    // object here is how a completed task kept drawing as in progress until the
    // next snapshot landed.
    installStateRune()
    const api = {
      tasksSidebarSnapshot: async () => ({ tasks: [task()], sessionsByTask: {} }),
      tasksUpdate: async () => ({ ...task(), status: 'done' }),
    }
    taskServerConnections.registerPrimary('local', api)
    Object.defineProperty(globalThis, 'window', {
      configurable: true, writable: true, value: { solus: api },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    expect(store.tasks[0]).toBe(store.get('task-1'))
    await store.get('task-1').setStatus('done')
    expect(store.tasks[0].status).toBe('done')
    expect(store.tasks).toHaveLength(1)
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
    await store.get('visible').loadDetails()
    await store.get('hidden').loadDetails()
    detailReads.splice(0)

    const stopWatching = store.get('visible').watchDetails()
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
    const first = store.get('task-1').loadDetails()
    const second = store.get('task-1').loadDetails()

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
    expect(store.get('remote-completed').serverId).toBe('remote')
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
    expect(store.get('shared-task').serverId).toBe('local')
    expect(store.get('shared-task').sessions.map((link) => link.sessionId)).toEqual(['primary-session'])
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
    expect(store.get('parent').attempts.map(({ sessionId }) => sessionId)).toEqual([
      'resumed-session',
    ])
    expect(store.get('child').attempts.map(({ sessionId }) => sessionId)).toEqual([
      'resumed-session',
    ])
  })

  test('keeps task and PR link identity when a link write changes nothing', async () => {
    // WHY: sidebar PR discovery re-runs whenever the task state it reads
    // changes. If an unchanged link reply still handed the store new objects,
    // every write would invalidate the inputs of the effect that sent it, and
    // discovery would run again on its own answer.
    installStateRune()
    const links = [{
      kind: 'pr' as const,
      targetScope: '/repo',
      targetKey: '65',
      title: '#65 Keep identity',
      url: 'https://github.com/openai/solus/pull/65',
      createdBy: 'system' as const,
      originSessionId: 'session-65',
    }]
    const api = {
      tasksSidebarSnapshot: async () => ({ tasks: [task()], sessionsByTask: {} }),
      tasksLink: async () => ({
        task: task(),
        comments: [],
        events: [],
        links: links.map((link) => ({ ...link })),
        subtasks: [],
      }),
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

    const input = {
      kind: 'pr' as const,
      targetScope: '/repo',
      targetKey: '65',
      createdBy: 'system' as const,
    }
    await store.get('task-1').link(input)
    const storedTask = store.tasks[0]
    const storedLinks = store.get('task-1').prLinks

    await store.get('task-1').link(input)

    expect(store.tasks[0]).toBe(storedTask)
    expect(store.get('task-1').prLinks).toBe(storedLinks)
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
            prLinkListsByTask: {
              'task-1': [
                {
                  number: 43,
                  url: 'https://github.com/openai/solus/pull/43',
                  createdBy: 'system',
                  originSessionId: 'session-43',
                },
                { number: 44, url: 'https://github.com/openai/solus/pull/44' },
              ],
            },
          }),
        },
      },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    expect(store.get('task-1').prLink).toEqual({
      number: 43,
      url: 'https://github.com/openai/solus/pull/43',
      createdBy: 'system',
      originSessionId: 'session-43',
    })
    expect(store.get('task-1').prLinks).toHaveLength(2)
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
    expect(store.get('sibling').sessions).toEqual([
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

    store.get('task-1').trackSessionStart('session-1')
    store.get('task-1').trackSessionStart('session-1')

    expect(store.get('task-1').sessions).toEqual([
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
    store.get('task-1').trackSessionStart('provider-session')

    store.rekeySessionBinding('provider-session', 'solus-session')

    expect(store.taskForSession('provider-session')).toBeNull()
    expect(store.taskForSession('solus-session')?.id).toBe('task-1')
    expect(store.get('task-1').sessions.map((attempt) => attempt.sessionId)).toEqual([
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
    store.get('task-1').trackSessionStart('provider-session')

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
    const firstSync = store.loadUpstream(projectKey)
    const duplicateSync = store.loadUpstream(projectKey)

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
    await store.get('task-1').loadDetails()

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

  test('homes a cross-host inbox ticket, and routes its writes there afterwards', async () => {
    // WHY: a ticket in the inbox reaches this client from several hosts at once,
    // and which one owns it is the user's choice after deduplication — the only
    // fact neither the provider nor any host can supply. Once the task is homed,
    // an ordinary update has to reach that host and that project without the
    // caller repeating them; before it is homed, the ticket must not appear in
    // the durable list, where the sidebar would draw it as real work.
    installStateRune()
    const updates: Array<{ cwd: string; id: string; status: unknown }> = []
    const ticket: Task = {
      id: '87',
      providerId: 'github',
      kind: 'task',
      title: 'Inbox ticket',
      body: '',
      status: 'todo',
      url: 'https://github.com/example/solus/issues/87',
      labels: [],
      updatedAt: 1_785_000_000_000,
    }
    const api = {
      tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
      tasksUpdateUpstream: async (cwd: string, id: string, patch: { status?: unknown }) => {
        updates.push({ cwd, id, status: patch.status })
        return { ...ticket, projectKey: cwd, status: 'in_progress' as const }
      },
    }
    taskServerConnections.registerPrimary('workshop', api)
    Object.defineProperty(globalThis, 'window', {
      configurable: true, writable: true, value: { solus: api },
    })

    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    await store.ensureLoaded()

    // The ticket has no project until the user picks one, so nothing lists it.
    const task = store.get(ticket.id).hydrate(ticket, 'workshop')
    expect(store.tasks).toHaveLength(0)

    task.placeIn({ serverId: 'workshop', projectKey: '/workspace/solus' })

    expect(store.upstreamTasksByProject.get('/workspace/solus')).toEqual([task])
    expect(store.tasks).toHaveLength(0)
    expect(store.hostForProject('/workspace/solus')).toBe('workshop')

    await task.update({ status: 'in_progress' })

    expect(updates).toEqual([{ cwd: '/workspace/solus', id: '87', status: 'in_progress' }])
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
    await store.get(issue.id, projectKey).loadDetails()
    await store.get(issue.id).comment('Posted from Solus')

    expect(store.get(issue.id).details?.comments).toEqual([
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
    const details = await store.get(issue.id, projectKey).loadDetails()

    expect(details.task.id).toBe('87')
    expect(store.get('87', projectKey)?.providerId).toBe('github')
    expect(upstreamGets).toBe(1)
  })
})

describe('upstream provider search', () => {
  /** One host whose upstream list records the query it was asked for. */
  function installUpstream(queries: (string | undefined)[]): void {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
          tasksListUpstream: async (_cwd: string, opts?: { query?: string }) => {
            queries.push(opts?.query)
            return { tasks: [] }
          },
        },
      },
    })
  }

  // WHY: a refresh, a reconnect, or a task event all reload the upstream list
  // without knowing a search is on screen. Dropping the query there would swap
  // the user's search results for the plain list mid-typing.
  test('an ordinary reload keeps the active search', async () => {
    installStateRune()
    const queries: (string | undefined)[] = []
    installUpstream(queries)
    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()

    await store.loadUpstream('/workspace/solus', { query: 'payment' })
    await store.loadUpstream('/workspace/solus')

    expect(queries).toEqual(['payment', 'payment'])
    expect(store.upstreamQueryByProject.get('/workspace/solus')).toBe('payment')
  })

  // And an empty query is how the page says the search box was cleared.
  test('an empty query clears the search', async () => {
    installStateRune()
    const queries: (string | undefined)[] = []
    installUpstream(queries)
    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()

    await store.loadUpstream('/workspace/solus', { query: 'payment' })
    await store.loadUpstream('/workspace/solus', { query: '' })

    expect(queries).toEqual(['payment', ''])
    expect(store.upstreamQueryByProject.has('/workspace/solus')).toBe(false)
  })

  // The in-flight load answers the question it was given. A newer search is a
  // different question, so it must not be answered by the older result.
  test('a new search is not satisfied by the load already running', async () => {
    installStateRune()
    const queries: (string | undefined)[] = []
    installUpstream(queries)
    const { TasksStore } = await import('@solus/workspace-ui/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()

    await Promise.all([
      store.loadUpstream('/workspace/solus', { query: 'pay' }),
      store.loadUpstream('/workspace/solus', { query: 'payment' }),
    ])

    expect(queries).toEqual(['pay', 'payment'])
  })
})

describe('conversation-card reverse links', () => {
  test('a stale read cannot restore a link after unlink completes', async () => {
    // WHY: task invalidation can start a reverse read just before the unlink
    // response updates the local cache. That older answer must not make the
    // "Linked to…" label flicker back into view.
    installStateRune()
    jest.useFakeTimers()
    const target = { kind: 'work' as const, targetScope: '', targetKey: 'work-1' }
    const linked = [{
      ...target,
      taskId: 'task-1',
      title: 'Fix sync',
      status: 'in_progress' as const,
      shortId: 184,
    }]
    let resolveStale: ((value: typeof linked) => void) | undefined
    let reads = 0
    const api = {
      tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
      tasksLinkedTo: async () => {
        reads++
        if (reads === 1) return linked
        return new Promise<typeof linked>((resolve) => { resolveStale = resolve })
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
    await store.ensureLinkedTasks([target], 'local')
    taskServerConnections.emit('local', 'tasks.invalidated', {})
    jest.advanceTimersByTime(101)
    await Promise.resolve()
    expect(reads).toBe(2)

    const beforeUnlink = store.linkedTasksFor(target)
    store.noteUnlinked(target, 'task-1')
    // SvelteMap observes its values through `set`; mutating the old array left
    // the card unchanged until the delayed invalidation read arrived.
    expect(store.linkedTasksFor(target)).not.toBe(beforeUnlink)
    expect(store.linkedTasksFor(target)).toEqual([])
    resolveStale?.(linked)
    await Promise.resolve()
    await Promise.resolve()

    expect(store.linkedTasksFor(target)).toEqual([])
  })
})
