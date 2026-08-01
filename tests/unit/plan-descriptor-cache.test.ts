import { afterEach, describe, expect, test } from 'bun:test'
import type { PlanDescriptor } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
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

    const { PlanStore } = await import('../../src/renderer/contexts/plans/plan.store.svelte')
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

    const { PlanStore } = await import('../../src/renderer/contexts/plans/plan.store.svelte')
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
