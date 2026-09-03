import { beforeAll, describe, expect, test } from 'bun:test'
import {
  parseRef,
  serializeRef,
  type RouteRef,
} from '@solus/workspace-ui/contexts/workspace/routing/route-registry'
import { MemoryRouteHistory } from '@solus/workspace-ui/contexts/workspace/routing/route-history'

let RouterStore: typeof import('@solus/workspace-ui/contexts/workspace/routing/router.store.svelte').RouterStore

beforeAll(async () => {
  // `.svelte.ts` runes are compiled away outside the Svelte build; the store's
  // reactivity is not what these assertions are about.
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ RouterStore } = await import('@solus/workspace-ui/contexts/workspace/routing/router.store.svelte'))
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
  test('a PR review route keeps its owning host and absolute checkout path', () => {
    // WHY: restore and deep links must not split the review worktree from the
    // host that owns its provider and diff RPCs.
    const ref: RouteRef = {
      name: 'prReview',
      params: { number: 41, serverId: 'host-b', cwd: '/work/solus' },
    }

    expect(parseRef(serializeRef(ref))).toEqual(ref)
  })

  test('every session-shaped route round-trips its host through one grammar', () => {
    // WHY: dispatch-client step 1 — a restored or deep-linked location must
    // name the host that owns the id, and `<id>~<serverId>` is the one codec
    // for all of them; a second grammar would fork parsing forever.
    const refs: RouteRef[] = [
      { name: 'chat', params: { sessionId: 'sess-1', serverId: 'host-a' } },
      { name: 'plan', params: { planId: 'sess-1__tool-1', serverId: 'host-a' } },
      { name: 'work', params: { workId: 'work-1', serverId: 'host-a' } },
      { name: 'task', params: { taskId: 'task-1', serverId: 'host-a' } },
      { name: 'goal', params: { sessionId: 'sess-1', serverId: 'host-a' } },
      { name: 'subagent', params: { sessionId: 'sess-1', messageId: 'msg-1', serverId: 'host-a' } },
      { name: 'automation', params: { automationId: 'auto-1', serverId: 'host-a' } },
      { name: 'prDiff', params: { number: 7, cwd: '/work/solus', serverId: 'host-a' } },
    ]
    for (const ref of refs) {
      expect(parseRef(serializeRef(ref))).toEqual(ref)
    }
  })

  test('the same routes still parse without a host', () => {
    // A host-less segment is a valid location (`plan/` mid-stream, a legacy
    // task link); it parses with no serverId rather than failing the pane.
    const refs: RouteRef[] = [
      { name: 'work', params: { workId: 'work-1' } },
      { name: 'task', params: { taskId: 'task-1' } },
      { name: 'goal', params: { sessionId: 'sess-1' } },
      { name: 'subagent', params: { sessionId: 'sess-1', messageId: 'msg-1' } },
      { name: 'prDiff', params: { number: 7 } },
    ]
    for (const ref of refs) {
      expect(parseRef(serializeRef(ref))).toEqual(ref)
    }
  })

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

  test('a target across from a pane does not depend on current focus', () => {
    // WHY: a symbol popover is portaled. Its action must preserve the source
    // editor or diff even if focus moved before the user chose a location.
    const router = new RouterStore()
    const leadingPaneId = router.leadingPane.id
    const companion = router.navigate(PLAN, { target: 'aside' })

    router.focusPane(leadingPaneId)
    expect(router.targetAcrossFrom(companion.id)).toBe(leadingPaneId)
    expect(router.targetAcrossFrom(leadingPaneId)).toBe(companion.id)
  })

  test('a target across from a lone pane creates a split', () => {
    // WHY: go-to-definition must not replace the file or diff being read.
    const router = new RouterStore()

    expect(router.targetAcrossFrom(router.leadingPane.id)).toBe('new')
  })

  test('every navigation bumps the epoch, including a repeat of the same route', () => {
    // What the diff panel watches to jump to a file: asking for the same file
    // twice has to move the panel again, so a changed param is not enough.
    const router = new RouterStore()
    const diff: RouteRef = { name: 'review', params: { sourceTabId: 'tab_a', view: 'diff', filePath: 'a.ts' } }
    router.navigate(diff, { target: 'aside' })
    const afterFirst = router.navigationEpoch

    router.navigate(diff, { target: 'aside' })
    expect(router.navigationEpoch).toBe(afterFirst + 1)

    router.navigate({ name: 'review', params: { sourceTabId: 'tab_a', view: 'diff', filePath: 'b.ts' } }, { target: 'aside' })
    expect(router.navigationEpoch).toBe(afterFirst + 2)
  })
})

describe('leading with a route that is already open', () => {
  const PR_REVIEW: RouteRef = { name: 'prReview', params: { number: 4821 } }

  test('a companion review takes the lead so a chat can open beside it', () => {
    // WHY: "Ask Solus" must never cost the user the review they asked about.
    // At the pane cap `aside` resolves back to the leading pane, so a review
    // sitting in the companion would have been overwritten by its own chat.
    const router = new RouterStore()
    router.navigate(PR_REVIEW, { target: 'aside' })

    router.leadWith('prReview')
    router.navigate({ name: 'chat', params: { sessionId: 'sess_pr' } }, { target: 'aside' })

    expect(router.panes.map((pane) => pane.base?.name)).toEqual(['prReview', 'chat'])
    expect(router.chatSessionIn(router.panes[1].id)).toBe('sess_pr')
  })

  test('reattaching an Ask Solus checkout keeps chat only in the secondary pane', () => {
    // WHY: checkout preparation completes after the chat pane opens. At that
    // point focus is in the secondary pane, where a second relative `aside`
    // points back at the leading pane and duplicates the conversation.
    const router = new RouterStore()
    router.navigate(PR_REVIEW)

    const reveal = () => {
      router.leadWith('prReview')
      router.navigate(
        { name: 'chat', params: { sessionId: 'sess_pr' } },
        { target: router.asidePanes[0]?.id ?? 'aside' },
      )
    }

    reveal()
    reveal()

    expect(router.panes.map((pane) => pane.base?.name)).toEqual(['prReview', 'chat'])
    expect(router.panes.filter((pane) => pane.base?.name === 'chat')).toHaveLength(1)
  })

  test('a review that already leads stays put, and its pane is not rebuilt', () => {
    const router = new RouterStore()
    const review = router.navigate(PR_REVIEW)

    router.leadWith('prReview')

    expect(router.panes).toHaveLength(1)
    expect(router.leadingPane.id).toBe(review.id)
  })

  test('a destination that is not open leaves the location alone', () => {
    const router = new RouterStore()
    router.navigate(PLAN, { target: 'aside' })

    router.leadWith('prReview')

    expect(router.panes.map((pane) => pane.base?.name)).toEqual(['chat', 'plan'])
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
