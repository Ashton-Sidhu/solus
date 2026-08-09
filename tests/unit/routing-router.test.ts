import { beforeAll, describe, expect, test } from 'bun:test'
import type { RouteRef } from '../../src/renderer/contexts/workspace/routing/route-registry'
import { MemoryRouteHistory } from '../../src/renderer/contexts/workspace/routing/route-history'

let RouterStore: typeof import('../../src/renderer/contexts/workspace/routing/router.store.svelte').RouterStore

beforeAll(async () => {
  // `.svelte.ts` runes are compiled away outside the Svelte build; the store's
  // reactivity is not what these assertions are about.
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ RouterStore } = await import('../../src/renderer/contexts/workspace/routing/router.store.svelte'))
})

const TASKS: RouteRef = { name: 'tasks', params: {} }
const PRS: RouteRef = { name: 'prs', params: {} }
const PLAN: RouteRef = { name: 'plan', params: { planId: 'p_1' } }

describe('history', () => {
  test('back and forward walk the locations that were visited', () => {
    const router = new RouterStore()
    router.navigate(TASKS)
    router.navigate(PRS)

    expect(router.at('prs')).toBe(true)
    expect(router.back()).toBe(true)
    expect(router.at('tasks')).toBe(true)
    expect(router.back()).toBe(true)
    expect(router.at('chat')).toBe(true)
    expect(router.back()).toBe(false)

    expect(router.forward()).toBe(true)
    expect(router.at('tasks')).toBe(true)
  })

  test('replace overwrites the current entry instead of stacking one', () => {
    const router = new RouterStore()
    router.navigate(TASKS)
    router.navigate({ name: 'task', params: { taskId: 'SOL-1' } }, { replace: true })

    expect(router.params('task')?.taskId).toBe('SOL-1')
    router.back()
    expect(router.at('task')).toBe(false)
  })

  test('navigating after going back drops the forward entries', () => {
    const router = new RouterStore()
    router.navigate(TASKS)
    router.navigate(PRS)
    router.back()
    router.navigate(PLAN)

    expect(router.canGoForward).toBe(false)
    expect(router.at('plan')).toBe(true)
  })

  test('the stack is capped, and the cap evicts the oldest entry', () => {
    // Budgeted at 50 entries of params only — never resolved payloads — so the
    // stack cannot grow for the renderer's lifetime.
    const router = new RouterStore()
    for (let i = 0; i < 80; i += 1) {
      router.navigate({ name: 'work', params: { workId: `w_${i}` } })
    }

    let depth = 0
    while (router.back()) depth += 1

    expect(depth).toBe(49)
    // The oldest surviving entry is a work, not the conversation the session
    // started on — proof the shift actually happened.
    expect(router.at('work')).toBe(true)
  })
})

describe('reading the location', () => {
  test('`at` answers for a destination wherever it is showing', () => {
    const router = new RouterStore()
    router.navigate(PLAN, { target: 'aside' })

    expect(router.at('plan')).toBe(true)
    expect(router.at('tasks')).toBe(false)
    expect(router.panes).toHaveLength(2)
  })

  test('a pinned chat names its session; the pooled one names none', () => {
    // The router answers in sessions and never in tabs — resolving a session to
    // the tab rendering it is the workspace's job, not routing's. The leading
    // pane names no session precisely because the pool decides which one shows.
    const router = new RouterStore()
    const pane = router.navigate({ name: 'chat', params: { sessionId: 'sess_b' } }, { target: 'aside' })

    expect(router.chatSessionIn(pane.id)).toBe('sess_b')
    expect(router.chatSessionIn(router.leadingPane.id)).toBeNull()
    expect(router.showsChat(router.leadingPane.id)).toBe(true)
  })

  test('every navigation bumps the epoch, including a repeat of the same route', () => {
    // What the diff panel watches to jump to a file: asking for the same file
    // twice has to move the panel again, so a changed param is not enough.
    const router = new RouterStore()
    const diff: RouteRef = { name: 'diff', params: { sourceTabId: 'tab_a', filePath: 'a.ts' } }
    router.navigate(diff, { target: 'aside' })
    const afterFirst = router.navigationEpoch

    router.navigate(diff, { target: 'aside' })
    expect(router.navigationEpoch).toBe(afterFirst + 1)

    router.navigate({ name: 'diff', params: { sourceTabId: 'tab_a', filePath: 'b.ts' } }, { target: 'aside' })
    expect(router.navigationEpoch).toBe(afterFirst + 2)
  })
})

describe('resolved payloads', () => {
  test('a route resolves once and is served from the cache after that', async () => {
    const router = new RouterStore()
    let calls = 0
    const ref: RouteRef = { name: 'prReview', params: { number: 7 } }
    const ctx = {
      api: { prOpenReview: async () => { calls += 1; return { number: 7 } } },
      ipc: () => ({}),
    } as unknown as Parameters<typeof router.resolve>[1]

    await router.resolve(ref, ctx)
    await router.resolve(ref, ctx)

    expect(calls).toBe(1)
    expect(router.resolvedFor<{ number: number }>(ref)).toEqual({ number: 7 })
  })

  test('concurrent entries share one in-flight fetch', async () => {
    const router = new RouterStore()
    let calls = 0
    const ref: RouteRef = { name: 'prReview', params: { number: 8 } }
    const ctx = {
      api: { prOpenReview: async () => { calls += 1; return { number: 8 } } },
      ipc: () => ({}),
    } as unknown as Parameters<typeof router.resolve>[1]

    await Promise.all([router.resolve(ref, ctx), router.resolve(ref, ctx)])

    expect(calls).toBe(1)
  })

  test('the payload cache is capped and evicts least-recently-used', async () => {
    const router = new RouterStore()
    for (let number = 0; number < 20; number += 1) {
      router.setResolved({ name: 'prReview', params: { number } }, { number })
    }

    expect(router.resolvedFor<{ number: number }>({ name: 'prReview', params: { number: 0 } })).toBeNull()
    expect(router.resolvedFor<{ number: number }>({ name: 'prReview', params: { number: 19 } })).toEqual({ number: 19 })
  })

  test('re-reading a payload keeps it from being evicted next', () => {
    const router = new RouterStore()
    for (let number = 0; number < 16; number += 1) {
      router.setResolved({ name: 'prReview', params: { number } }, { number })
    }
    // Touch the oldest, then push one more in: the next-oldest goes instead.
    router.setResolved({ name: 'prReview', params: { number: 0 } }, { number: 0 })
    router.setResolved({ name: 'prReview', params: { number: 99 } }, { number: 99 })

    expect(router.resolvedFor<{ number: number }>({ name: 'prReview', params: { number: 0 } })).toEqual({ number: 0 })
    expect(router.resolvedFor<{ number: number }>({ name: 'prReview', params: { number: 1 } })).toBeNull()
  })
})

describe('injected route history', () => {
  test('back and forward use the injected history adapter', () => {
    const history = new MemoryRouteHistory('/chat/a')
    const router = new RouterStore(history)

    router.navigate({ name: 'chat', params: { sessionId: 'b' } })
    router.navigate({ name: 'settings', params: { tab: 'tools' } })
    expect(router.params('settings')).toEqual({ tab: 'tools' })

    router.back()
    expect(router.params('chat')).toEqual({ sessionId: 'b' })

    router.back()
    expect(router.params('chat')).toEqual({ sessionId: 'a' })

    router.forward()
    expect(router.params('chat')).toEqual({ sessionId: 'b' })
  })
})
