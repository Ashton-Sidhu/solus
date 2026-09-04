import { afterEach, describe, expect, test } from 'bun:test'
import type { ReviewGuideStatusEvent, ReviewTarget } from '@solus/contracts/review'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'

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

const HOST = 'host-a'

describe('ReviewGuideStore', () => {
  test('rehydrates a cached branch guide independently of its view component', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
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

    await store.load(api, HOST, {} as never, identity, 'branch')

    expect(store.statusFor(HOST, identity)).toEqual(cached)
    // A remounted GitSection reads the same persistent store entry.
    expect(store.statusFor(HOST, { ...identity })).toEqual(cached)
  })

  test('does not expose a cached guide after the checkout head changes', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const api = {} as typeof window.solus

    store.set(HOST, status())

    expect(store.statusFor(HOST, {
      repoRoot: '/repo',
      key: 'feature__reviews',
      headSha: 'head-b',
    })).toBeNull()
  })

  test('a late cache probe cannot replace the newer checkout state', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
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

    const firstLoad = store.load(api, HOST, { request: 'first' } as never, first, 'branch')
    const secondLoad = store.load(api, HOST, { request: 'second' } as never, second, 'branch')
    resolvers.get('second')?.(status({ headSha: 'head-b', updatedAt: 2 }))
    await secondLoad
    resolvers.get('first')?.(status())
    await firstLoad

    expect(store.statusFor(HOST, second)?.headSha).toBe('head-b')
  })

  test('keeps generation progress after the initiating component unmounts', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
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

    await store.generate(api, HOST, {} as never, identity, { scope: 'branch' })
    expect(store.statusFor(HOST, identity)?.status).toBe('queued')

    events.receive({
      type: 'review.guideStatusChanged',
      payload: status({ status: 'ready', updatedAt: 2 }),
      occurredAt: 2,
    })
    expect(store.statusFor(HOST, identity)?.status).toBe('ready')
  })

  test('shows manual session review progress in the action row identity', async () => {
    // WHY: /review:session names a typed target, while the session action row
    // names the same guide by its stable session key. Both surfaces must read
    // one lifecycle entry or the button stays idle during manual generation.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const events = new HostEventSubscriber()
    const store = new ReviewGuideStore(() => events)
    const actionRowIdentity = { repoRoot: '/repo', key: 'session-provider-1' }

    store.bind(HOST)
    events.receive({
      type: 'review.guideStatusChanged',
      payload: status({
        key: 'session-provider-1',
        scope: 'session',
        target: { kind: 'session' },
        status: 'generating',
      }),
      occurredAt: 2,
    })

    expect(store.statusFor(HOST, actionRowIdentity)?.status).toBe('generating')
  })

  test('notifies once when a live generation becomes ready, but not for cached guides', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const events = new HostEventSubscriber()
    const cached = status()
    const api = { reviewGuideStatus: async () => cached } as unknown as typeof window.solus
    const store = new ReviewGuideStore(() => events)
    const readyEvents: ReviewGuideStatusEvent[] = []
    store.onReady((_serverId, event) => readyEvents.push(event))

    await store.load(api, HOST, {} as never, { repoRoot: '/repo', key: cached.key }, 'branch')
    expect(readyEvents).toEqual([])

    events.receive({
      type: 'review.guideStatusChanged',
      payload: status({ status: 'generating', updatedAt: 2 }),
      occurredAt: 2,
    })
    events.receive({
      type: 'review.guideStatusChanged',
      payload: status({ status: 'ready', updatedAt: 3 }),
      occurredAt: 3,
    })
    events.receive({
      type: 'review.guideStatusChanged',
      payload: status({ status: 'ready', updatedAt: 3 }),
      occurredAt: 3,
    })

    expect(readyEvents.map((event) => event.updatedAt)).toEqual([3])
  })

  test('clears only the opened ready indicator and restores it for a regenerated guide', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const identity = { repoRoot: '/repo', key: 'feature__reviews' }

    store.set(HOST, status({ updatedAt: 2 }))
    expect(store.indicatorStatusFor(HOST, identity)?.status).toBe('ready')
    store.markOpened(HOST, identity)
    expect(store.indicatorStatusFor(HOST, identity)).toBeNull()
    expect(store.statusFor(HOST, identity)?.status).toBe('ready')

    store.set(HOST, status({ status: 'generating', updatedAt: 3 }))
    expect(store.indicatorStatusFor(HOST, identity)?.status).toBe('generating')
    store.set(HOST, status({ updatedAt: 4 }))
    expect(store.indicatorStatusFor(HOST, identity)?.status).toBe('ready')
  })

  test('treats a cached session guide as read when its closed session reopens', async () => {
    // WHY: reopening the conversation is already an acknowledgement of its
    // completed work. Restoring a cached guide must not add a fresh sidebar
    // notification for work that finished before the session was reopened.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const cached = status({
      key: 'session-provider-1',
      scope: 'session',
      target: { kind: 'session' },
    })
    const api = { reviewGuideStatus: async () => cached } as unknown as typeof window.solus
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const identity = { repoRoot: '/repo', key: cached.key }

    await store.acknowledgeSessionGuide(api, HOST, {} as never, identity)

    expect(store.statusFor(HOST, identity)?.status).toBe('ready')
    expect(store.indicatorStatusFor(HOST, identity)).toBeNull()
  })

  test('does not acknowledge a session guide that finishes after the session reopens', async () => {
    // WHY: reopening while generation is in flight must not consume the future
    // completion notification. Only the guide that already existed is read.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const generating = status({
      key: 'session-provider-1',
      scope: 'session',
      target: { kind: 'session' },
      status: 'generating',
    })
    const api = { reviewGuideStatus: async () => generating } as unknown as typeof window.solus
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const identity = { repoRoot: '/repo', key: generating.key }

    await store.acknowledgeSessionGuide(api, HOST, {} as never, identity)
    store.set(HOST, { ...generating, status: 'ready', updatedAt: 2 })

    expect(store.indicatorStatusFor(HOST, identity)?.status).toBe('ready')
  })

  test('keys guide state by host, never by the connection handle', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const identity = { repoRoot: '/repo', key: 'feature__reviews' }

    store.set(HOST, status())

    // WHY: a host's guide state belongs to the host and survives its socket
    // being released and re-dialled — the id is the same either way. Two hosts
    // sharing a repo path and branch are still two different reviews, so the
    // per-host partition has to be real and not one flat map.
    expect(store.statusFor(HOST, identity)).toEqual(status())
    expect(store.statusFor('host-b', identity)).toBeNull()
  })

  test('adopts the host key for a target whose branch the client cannot read', async () => {
    // WHY: the key for a working-tree target embeds the live branch, which only
    // the host can read — a session outside a Solus worktree carries no
    // gitContext, so the client had been guessing `working-tree-detached`.
    // Matching the response on that guess discarded the very answer that
    // reveals the real key, and the card sat on "Preparing" forever.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const target = { kind: 'working-tree' } as const
    const fromHost = status({ key: 'working-tree-main', scope: 'working-tree', target })
    const api = { reviewGuideStatus: async () => fromHost } as unknown as typeof window.solus
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    // The key the client would have guessed with no gitContext to read.
    const identity = { repoRoot: '/repo', key: 'working-tree-detached', target }

    await store.load(api, HOST, {} as never, identity, target)

    // Found under the target, despite the key never matching.
    expect(store.statusFor(HOST, identity)).toEqual(fromHost)
  })

  test('adopts an arbitrary PR status from its managed checkout', async () => {
    // WHY: the conversation belongs to the project where the command was
    // typed, but an arbitrary PR URL resolves on the host to another repository
    // and checkout. Target identity, not either repoRoot, is what joins them.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const target = {
      kind: 'pr',
      host: 'github.com',
      owner: 'acme',
      repo: 'external-app',
      number: 42,
    } as const
    const fromHost = status({
      repoRoot: '/host/review-checkouts/external-app-42',
      key: 'pr-github.com-acme-external-app-42',
      scope: 'pr',
      target,
    })
    const api = { reviewGuideStatus: async () => fromHost } as unknown as typeof window.solus
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const identity = { repoRoot: '/requesting/project', key: fromHost.key, target }

    await store.load(api, HOST, {} as never, identity, target)

    expect(store.statusFor(HOST, identity)).toEqual(fromHost)
  })

  test.each([
    [{ kind: 'working-tree' }, 'working-tree-main', 'working-tree'],
    [{ kind: 'session' }, 'session-provider-1', 'session'],
    [{ kind: 'branch', targetBranch: 'main' }, 'main', 'branch'],
    [{ kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 42 }, 'pr-github.com-acme-app-42', 'pr'],
  ] as Array<[ReviewTarget, string, ReviewGuideStatusEvent['scope']]>)('settles a completed %s request as outdated when its reviewed change moved', async (target, key, scope) => {
    // WHY: any live review target can finish after its resolved change moves.
    // That is a terminal retry state, not a missing status; a missing status
    // leaves the completed conversation card preparing forever.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const outdated = status({
      key,
      scope,
      target,
      status: 'outdated',
      changeFingerprint: 'new-fingerprint',
    })
    const api = { reviewGuideStatus: async () => outdated } as unknown as typeof window.solus
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const identity = { repoRoot: '/repo', key: outdated.key, target }

    await store.load(api, HOST, {} as never, identity, target)

    expect(store.statusFor(HOST, identity)?.status).toBe('outdated')
  })

  test.each([
    [{ kind: 'working-tree' }, 'working-tree-main', 'working-tree'],
    [
      { kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 42 },
      'pr-github.com-acme-app-42',
      'pr',
    ],
  ] as Array<[ReviewTarget, string, ReviewGuideStatusEvent['scope']]>)('a live %s event and its card find the same entry without sharing a repository', async (target, key, scope) => {
    // WHY: events arrive keyed by the host's branch-embedded key while the card
    // can belong to a different checkout than the conversation card. One map
    // keyed by target is what makes those meet; a second key→target index could
    // drift across a branch switch or managed PR checkout.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const store = new ReviewGuideStore(() => new HostEventSubscriber())

    store.set(HOST, status({ repoRoot: '/managed/checkout', key, scope, target }))
    expect(store.statusFor(HOST, { repoRoot: '/requesting/project', key: 'anything', target })?.status).toBe('ready')

    // A later event for the same target replaces the entry rather than adding
    // one under its checkout or generated guide key.
    store.set(HOST, status({ repoRoot: '/other/checkout', key: `${key}-next`, scope, target, status: 'generating' }))
    expect(store.statusFor(HOST, { repoRoot: '/requesting/project', key: 'anything', target })?.status).toBe('generating')
  })

  test('still matches on key when the request named a scope, not a target', async () => {
    // WHY: a scope request carries no target to match, so relaxing the key check
    // for it would let any guide the host happens to answer with land on this
    // identity.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewGuideStore } = await import(
      '@solus/workspace-ui/components/review/review-guide.store.svelte'
    )
    const other = status({ key: 'some-other-branch' })
    const api = { reviewGuideStatus: async () => other } as unknown as typeof window.solus
    const store = new ReviewGuideStore(() => new HostEventSubscriber())
    const identity = { repoRoot: '/repo', key: 'feature__reviews' }

    await store.load(api, HOST, {} as never, identity, 'branch')

    expect(store.statusFor(HOST, identity)).toBeNull()
  })
})
