import { afterEach, describe, expect, test } from 'bun:test'
import type { ReviewGuideStatusEvent } from '../../src/shared/review'
import { HostEventSubscriber } from '../../src/client-core/host-event-subscriber'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function status(overrides: Partial<ReviewGuideStatusEvent> = {}): ReviewGuideStatusEvent {
  return {
    repoRoot: '/repo',
    key: 'feature__reviews',
    scope: 'branch',
    status: 'ready',
    headSha: 'head-a',
    updatedAt: 1,
    ...overrides,
  }
}

describe('ReviewGuideStore', () => {
  test('rehydrates a cached branch guide independently of its view component', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '../../src/renderer/components/review/review-guide.store.svelte'
    )
    const cached = status()
    const api = { reviewGuideStatus: async () => cached } as unknown as typeof window.solus
    const identity = {
      repoRoot: '/repo',
      key: 'feature__reviews',
      headSha: 'head-a',
      revision: 'head-a|src/a.ts',
    }
    const store = new ReviewGuideStore(() => new HostEventSubscriber())

    await store.load(api, {} as never, identity, 'branch')

    expect(store.statusFor(api, identity)).toEqual(cached)
    // A remounted GitSection reads the same persistent store entry.
    expect(store.statusFor(api, { ...identity })).toEqual(cached)
  })

  test('does not expose a cached guide after the checkout head changes', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '../../src/renderer/components/review/review-guide.store.svelte'
    )
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const api = {} as typeof window.solus

    store.set(api, status())

    expect(store.statusFor(api, {
      repoRoot: '/repo',
      key: 'feature__reviews',
      headSha: 'head-b',
    })).toBeNull()
  })

  test('a late cache probe cannot replace the newer checkout state', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '../../src/renderer/components/review/review-guide.store.svelte'
    )
    const resolvers = new Map<string, (event: ReviewGuideStatusEvent) => void>()
    const api = {
      reviewGuideStatus: (ctx: { request: string }) =>
        new Promise<ReviewGuideStatusEvent>((resolve) => {
          resolvers.set(ctx.request, resolve)
        }),
    } as unknown as typeof window.solus
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const first = {
      repoRoot: '/repo',
      key: 'feature__reviews',
      headSha: 'head-a',
      revision: 'head-a|src/a.ts',
    }
    const second = {
      ...first,
      headSha: 'head-b',
      revision: 'head-b|src/b.ts',
    }

    const firstLoad = store.load(api, { request: 'first' } as never, first, 'branch')
    const secondLoad = store.load(api, { request: 'second' } as never, second, 'branch')
    resolvers.get('second')?.(status({ headSha: 'head-b', updatedAt: 2 }))
    await secondLoad
    resolvers.get('first')?.(status())
    await firstLoad

    expect(store.statusFor(api, second)?.headSha).toBe('head-b')
  })

  test('keeps generation progress after the initiating component unmounts', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '../../src/renderer/components/review/review-guide.store.svelte'
    )
    const events = new HostEventSubscriber()
    const queued = status({ status: 'queued' })
    const api = { requestReviewGuide: async () => queued } as unknown as typeof window.solus
    const identity = {
      repoRoot: '/repo',
      key: 'feature__reviews',
      revision: 'head-a|src/a.ts',
    }
    const store = new ReviewGuideStore(() => events)

    await store.generate(api, {} as never, identity, { scope: 'branch' })
    expect(store.statusFor(api, identity)?.status).toBe('queued')

    events.receive({
      type: 'review.guideStatusChanged',
      payload: status({ status: 'ready', updatedAt: 2 }),
      occurredAt: 2,
    })
    expect(store.statusFor(api, identity)?.status).toBe('ready')
  })
})
