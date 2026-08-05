import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Task } from '../../src/shared/task-types'

mock.module('@client-core/server-connections', () => ({
  serverConnections: {
    eventsFor: () => ({ subscribe: () => () => {} }),
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
          tasksList: async () => ({ tasks: [task()] }),
          tasksSessions: async () => ({}),
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
          tasksList: async () => ({ tasks: [] }),
          tasksListUpstream: () => {
            upstreamCalls++
            return upstream
          },
          tasksSessions: async () => ({}),
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
          tasksList: async () => ({ tasks: [] }),
          tasksListUpstream: async () => ({ tasks: [], fetchedAt }),
          tasksSessions: async () => ({}),
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
    let resolveLinks!: (links: Record<string, unknown[]>) => void
    const links = new Promise<Record<string, unknown[]>>((resolve) => {
      resolveLinks = resolve
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          tasksList: async () => ({ tasks: [task()] }),
          tasksSessions: () => links,
        },
      },
    })

    const { TasksStore } = await import('../../src/renderer/contexts/tasks/tasks.store.svelte')
    const store = new TasksStore()
    const hydration = store.ensureLoaded()
    await Promise.resolve()
    await Promise.resolve()

    expect(store.tasks).toHaveLength(1)
    expect(store.loaded).toBe(false)
    expect(store.taskForSession('session-1')).toBeNull()

    resolveLinks({
      'task-1': [{ taskId: 'task-1', sessionId: 'session-1', linkedAt: 1 }],
    })
    await hydration

    expect(store.loaded).toBe(true)
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
          tasksList: async () => ({ tasks: [] }),
          tasksListUpstream: async () => ({ tasks: [issue] }),
          tasksSessions: async () => ({}),
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
          tasksList: async () => ({ tasks: [] }),
          tasksSessions: async () => ({}),
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
