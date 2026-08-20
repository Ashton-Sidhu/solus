import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { PlanComment, PlanDescriptor, Work, WorkMeta } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

beforeEach(() => {
  connections.reset()
  connections.phaseFor = () => 'connected'
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
})

afterEach(() => {
  connections.reset()
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function descriptor(title: string, timestamp: number): PlanDescriptor {
  return {
    provider: 'claude-code',
    sessionId: `session-${timestamp}`,
    planToolUseId: `plan-${timestamp}`,
    projectPath: '-repo',
    cwd: '/repo',
    timestamp,
    title,
    excerpt: '',
    status: 'pending',
    commentCount: 0,
    bookmarked: false,
    revisions: [],
  }
}

function work(id: string, title = id): Work {
  return {
    id,
    title,
    content: `Content for ${title}`,
    preview: title,
    type: 'doc',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: [],
    agentProvider: 'claude-code',
    cwd: '/repo',
    storage: { kind: 'local' },
  }
}

function workMeta(value: Work): WorkMeta & { id: string } {
  const { content: _content, ...result } = value
  return result
}

function samePathDescriptor(sessionId: string, title: string): PlanDescriptor {
  return {
    ...descriptor(title, 1),
    sessionId,
    planFilePath: '/repo/.plans/shared.md',
  }
}

const comment: PlanComment = {
  id: 'comment-1',
  comment: 'Keep this host-scoped.',
  author: 'you',
  createdAt: 1,
}

describe('plan descriptor cache', () => {
  test('idle preload exposes plans to gallery and autocomplete immediately', async () => {
    // WHY: both surfaces read the same visible all-project cache. Warming it
    // must populate that cache, not merely hide the result in MemoryCache.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )

    const warmed = [descriptor('Warmed plan', 1)]
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: { listPlans: () => Promise.resolve(warmed) } },
    })

    const { PlanStore } = await import('@solus/workspace-ui/contexts/plans/plan.store.svelte')
    const store = new PlanStore()
    store.preloadAllDescriptors()
    await Bun.sleep(0)

    expect(store.cachedDescriptorKey).toBe(
      store.descriptorCacheKey(undefined, true),
    )
    expect(store.cachedDescriptors).toEqual(warmed)
  })

  test('shows stale plans immediately while refreshing the shared gallery list', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )

    let finishRefresh!: (plans: PlanDescriptor[]) => void
    const refresh = new Promise<PlanDescriptor[]>((resolve) => {
      finishRefresh = resolve
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: { listPlans: () => refresh } },
    })

    const { PlanStore } = await import('@solus/workspace-ui/contexts/plans/plan.store.svelte')
    const store = new PlanStore()
    const key = store.descriptorCacheKey(undefined, true)
    const stale = [descriptor('Cached plan', 1)]
    const fresh = [descriptor('Fresh plan', 1)]
    ;(store as any)._descriptorCache.set(key, stale, { ttlMs: -1 })

    const visible = await store.getDescriptors(undefined, true)

    expect(visible).toEqual(stale)
    expect(store.cachedDescriptors).toEqual(stale)
    expect(store.isDescriptorLoading(key)).toBe(true)

    finishRefresh(fresh)
    await refresh
    await Bun.sleep(0)

    expect(store.cachedDescriptors).toEqual(fresh)
    expect(store.isDescriptorLoading(key)).toBe(false)
  })
})

describe('works federation', () => {
  test('an offline host does not block healthy documents', async () => {
    // WHY: catalog sockets queue RPCs while they retry. The Workspace must not
    // wait for an unavailable host before it can show documents from live hosts.
    connections.registerPrimary('host-a', { listWorks: async () => [workMeta(work('work-a'))] })
    let remoteConnected = false
    connections.registerHost('host-b', {
      listWorks: () => remoteConnected
        ? Promise.resolve([workMeta(work('work-b'))])
        : new Promise(() => {}),
    })
    connections.phaseFor = (serverId: string) =>
      serverId === 'host-b' && !remoteConnected ? 'offline' : 'connected'
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()

    await store.loadAll('/repo')

    expect(store.get('work-a')).toBeDefined()
    expect(store.listLoading).toBe(false)

    remoteConnected = true
    await store.loadAll('/repo')

    expect(store.get('work-b')).toBeDefined()
  })

  test('a failed host does not evict its work from the union', async () => {
    // WHY: a failed fan-out read contributes nothing. It is not proof that the
    // host deleted every work it owns.
    connections.registerPrimary('host-a', { listWorks: async () => [workMeta(work('work-a'))] })
    connections.registerHost('host-b', { listWorks: async () => [workMeta(work('work-b'))] })
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()
    await store.loadAll('/repo')

    connections.registerHost('host-b', { listWorks: async () => { throw new Error('offline') } })
    await store.loadAll('/repo')

    expect(store.get('work-a')).toBeDefined()
    expect(store.get('work-b')).toBeDefined()
  })

  test('reconciliation removes only deletions confirmed by the owner host', async () => {
    // WHY: one answering host can delete only its own missing rows. It cannot
    // make a failed peer's rows disappear.
    connections.registerPrimary('host-a', { listWorks: async () => [workMeta(work('work-a'))] })
    connections.registerHost('host-b', { listWorks: async () => [workMeta(work('work-b'))] })
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()
    await store.loadAll('/repo')

    connections.registerPrimary('host-a', { listWorks: async () => { throw new Error('offline') } })
    connections.registerHost('host-b', { listWorks: async () => [] })
    await store.loadAll('/repo')

    expect(store.get('work-a')).toBeDefined()
    expect(store.get('work-b')).toBeUndefined()
  })

  test('writes route to the host that listed the work', async () => {
    // WHY: a primary-host save can succeed against the wrong database and make
    // a remote work appear to save while its owner never changes.
    const calls: string[] = []
    connections.registerPrimary('host-a', {
      listWorks: async () => [workMeta(work('work-a'))],
      saveWork: async () => { calls.push('host-a'); return work('work-a') },
    })
    connections.registerHost('host-b', {
      listWorks: async () => [workMeta(work('work-b'))],
      saveWork: async () => { calls.push('host-b'); return work('work-b', 'Saved') },
    })
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()
    await store.loadAll('/repo')

    await store.save('work-b', { title: 'Saved' })

    expect(calls).toEqual(['host-b'])
  })

  test('a session-stream insert stamps its emitting host', async () => {
    // WHY: the first user edit can happen before any gallery list. The stream
    // edge must place the owner immediately.
    connections.registerPrimary('host-a', {})
    connections.registerHost('host-b', {})
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()

    store.finalizeProvisional(null, 'stream-work', 'Remote work', 'doc', 'Body', 'host-b')

    expect(store.hostFor('stream-work')).toBe('host-b')
  })
})

describe('plans federation', () => {
  test('an offline host does not block healthy plans', async () => {
    // WHY: one unavailable catalog host must not leave the whole Workspace in
    // its loading state when another host has already answered.
    connections.registerPrimary('host-a', { listPlans: async () => [descriptor('Plan A', 1)] })
    let remoteConnected = false
    connections.registerHost('host-b', {
      listPlans: () => remoteConnected
        ? Promise.resolve([descriptor('Plan B', 2)])
        : new Promise(() => {}),
    })
    connections.phaseFor = (serverId: string) =>
      serverId === 'host-b' && !remoteConnected ? 'offline' : 'connected'
    const { PlanStore } = await import('@solus/workspace-ui/contexts/plans/plan.store.svelte')
    const store = new PlanStore()

    const plans = await store.getDescriptors(undefined, true)

    expect(plans.map((plan) => plan.title)).toEqual(['Plan A'])
    expect(store.isDescriptorLoading(store.descriptorCacheKey(undefined, true))).toBe(false)

    remoteConnected = true
    const refreshed = await store.refreshAllDescriptors()

    expect(refreshed.map((plan) => plan.title)).toEqual(['Plan B', 'Plan A'])
  })

  test('an offline host keeps its cached plans in the Workspace', async () => {
    // WHY: skipping a queued RPC is not evidence that the remote plan was
    // deleted. Its last known row must remain beside fresh rows from live hosts.
    let remoteConnected = true
    connections.registerPrimary('host-a', { listPlans: async () => [descriptor('Plan A', 1)] })
    connections.registerHost('host-b', { listPlans: async () => [descriptor('Plan B', 2)] })
    connections.phaseFor = (serverId: string) =>
      serverId === 'host-b' && !remoteConnected ? 'offline' : 'connected'
    const { PlanStore } = await import('@solus/workspace-ui/contexts/plans/plan.store.svelte')
    const store = new PlanStore()
    await store.getDescriptors(undefined, true)

    remoteConnected = false
    const refreshed = await store.refreshAllDescriptors()

    expect(refreshed.map((plan) => plan.title)).toEqual(['Plan B', 'Plan A'])
  })

  test('annotation persistence routes to the plan owner host', async () => {
    // WHY: the reviewing agent reads annotations on its own host. Saving the
    // comment on primary leaves the review loop one-way.
    const calls: string[] = []
    connections.registerPrimary('host-a', { savePlanAnnotations: async () => calls.push('host-a') })
    connections.registerHost('host-b', { savePlanAnnotations: async () => calls.push('host-b') })
    const { PlanStore } = await import('@solus/workspace-ui/contexts/plans/plan.store.svelte')
    const store = new PlanStore()
    const planId = store.upsertFromStream({
      serverId: 'host-b',
      sessionId: 'session-b',
      planToolUseId: 'plan-b',
      projectPath: '-repo',
      cwd: '/repo',
      content: '# Remote plan',
      timestamp: 1,
    })

    store.addComment(planId, comment)
    await Bun.sleep(350)

    expect(calls).toEqual(['host-b'])
  })

  test('same-path plans from two hosts remain distinct', async () => {
    // WHY: an absolute path names files only within one host. Host-qualified
    // descriptor identity must retain both gallery rows.
    connections.registerPrimary('host-a', { listPlans: async () => [samePathDescriptor('session-a', 'Plan A')] })
    connections.registerHost('host-b', { listPlans: async () => [samePathDescriptor('session-b', 'Plan B')] })
    const { PlanStore } = await import('@solus/workspace-ui/contexts/plans/plan.store.svelte')
    const store = new PlanStore()

    const plans = await store.getDescriptors(undefined, true)

    expect(plans).toHaveLength(2)
    expect(plans.map((plan) => `${plan.serverId}:${plan.title}`).sort()).toEqual([
      'host-a:Plan A',
      'host-b:Plan B',
    ])
  })
})
