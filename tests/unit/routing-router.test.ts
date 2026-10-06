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
const CHAT: RouteRef = { name: 'chat', params: {} }
const TASK: RouteRef = { name: 'task', params: { taskId: 't_1' } }

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

  test('`at` answers for the destination and the surface on screen, not one in the background', () => {
    const router = new RouterStore()
    router.navigate(PLAN)
    router.navigate(TASK, { background: true })

    expect(router.at('chat')).toBe(true)
    expect(router.at('plan')).toBe(true)
    expect(router.at('task')).toBe(false)
  })

  test('a chat surface names its session; the pooled one names none', () => {
    // The router answers in sessions and never in tabs — resolving a session to
    // the tab rendering it is the workspace's job, not routing's. The leading
    // pane names no session precisely because the pool decides which one shows.
    const router = new RouterStore()
    const pane = router.navigate({ name: 'chat', params: { sessionId: 'sess_b' } }, { target: 'companion' })

    expect(router.chatSessionIn(pane.id)).toBe('sess_b')
    expect(router.chatSessionIn(router.leadingPane.id)).toBeNull()
    expect(router.showsChat(router.leadingPane.id)).toBe(true)
  })

  test('every navigation bumps the epoch, including a repeat of the same route', () => {
    // What the diff panel watches to jump to a file: asking for the same file
    // twice has to move the panel again, so a changed param is not enough.
    const router = new RouterStore()
    const diff: RouteRef = { name: 'review', params: { sourceTabId: 'tab_a', view: 'diff', filePath: 'a.ts' } }
    router.navigate(diff)
    const afterFirst = router.navigationEpoch

    router.navigate(diff)
    expect(router.navigationEpoch).toBe(afterFirst + 1)

    router.navigate({ name: 'review', params: { sourceTabId: 'tab_a', view: 'diff', filePath: 'b.ts' } })
    expect(router.navigationEpoch).toBe(afterFirst + 2)
  })
})

describe('strips belong to destinations', () => {
  const REVIEW: RouteRef = { name: 'review', params: { sourceTabId: 'tab_a', view: 'diff' } }
  const WORK: RouteRef = { name: 'work', params: { workId: 'w_1' } }

  function stripOf(router: InstanceType<typeof RouterStore>): string[] {
    return router.companionPane?.surfaces.map((ref) => ref.name) ?? []
  }

  test('leaving a page puts its strip away, and coming back brings it again', () => {
    // WHY: the task opened beside the board is the board's. Moving to another
    // page must not show it there, and must not lose it.
    const router = new RouterStore()
    router.navigate(TASKS)
    router.navigate(TASK)

    router.navigate(PRS)
    expect(stripOf(router)).toEqual([])

    router.navigate(TASKS)
    expect(stripOf(router)).toEqual(['task'])
  })

  test('each conversation in the pool keeps its own strip', () => {
    // WHY: a diff belongs to the conversation that made the change. Switching
    // to another conversation must not show the first one's diff beside it.
    const router = new RouterStore()
    let activeSession = 's_1'
    router.poolDestinationKey = () => `session:${activeSession}`
    router.syncDestination()
    router.navigate(REVIEW)

    activeSession = 's_2'
    router.syncDestination()
    expect(stripOf(router)).toEqual([])

    activeSession = 's_1'
    router.syncDestination()
    expect(stripOf(router)).toEqual(['review'])
  })

  test('hiding the companion keeps its strip, and the next surface joins it', () => {
    const router = new RouterStore()
    router.navigate(TASK)
    router.navigate(PLAN)

    router.hideCompanion()
    expect(router.companionPane).toBeNull()
    expect(router.hasHiddenStrip).toBe(true)

    router.navigate(WORK)
    expect(stripOf(router)).toEqual(['task', 'plan', 'work'])
  })

  test('showing a hidden strip brings it back with focus', () => {
    const router = new RouterStore()
    router.navigate(TASK)
    router.hideCompanion()

    router.showCompanion()

    expect(stripOf(router)).toEqual(['task'])
    expect(router.focusedPaneId).toBe(router.companionPane?.id)
    expect(router.hasHiddenStrip).toBe(false)
  })

  test('a sent draft gives its strip to the conversation it started', () => {
    // WHY: a task's lead is written with the task beside it. Send must keep
    // the task there, now beside the conversation.
    const router = new RouterStore()
    router.poolDestinationKey = () => 'session:s_new'
    router.navigate({ name: 'draft', params: { draftId: 'd_1' } })
    router.navigate(TASK)

    router.carryStrip('draft:d_1', 'session:s_new')
    router.navigate(CHAT)

    expect(stripOf(router)).toEqual(['task'])
  })

  test('the strip follows a draft that became the destination\'s conversation first', () => {
    // WHY: starting the session can make the conversation the destination
    // before the strip is handed over; the strip must still land beside it.
    const router = new RouterStore()
    let activeSession: string | null = null
    router.poolDestinationKey = () => (activeSession ? `session:${activeSession}` : null)
    router.navigate({ name: 'draft', params: { draftId: 'd_1' } })
    router.navigate(TASK)

    activeSession = 's_new'
    router.navigate(CHAT)
    expect(stripOf(router)).toEqual([])

    router.carryStrip('draft:d_1', 'session:s_new')
    expect(stripOf(router)).toEqual(['task'])
  })

  test('a draft tab put away with a page is still known to the workspace', () => {
    // WHY: a draft nobody can see looks abandoned. Counted as composed, it is
    // not taken as the leading pane's home or dropped while its page is away.
    const router = new RouterStore()
    const draft: RouteRef = { name: 'draft', params: { draftId: 'd_side' } }
    router.navigate(TASKS)
    router.navigate(draft, { target: 'companion' })

    router.navigate(PRS)

    expect(router.storedSurfaces).toEqual([draft])
  })

  test('a closed conversation\'s strip is forgotten', () => {
    const router = new RouterStore()
    let activeSession = 's_1'
    router.poolDestinationKey = () => `session:${activeSession}`
    router.syncDestination()
    router.navigate(REVIEW)
    activeSession = 's_2'
    router.syncDestination()

    router.dropStrip('session:s_1')
    activeSession = 's_1'
    router.syncDestination()

    expect(stripOf(router)).toEqual([])
  })

  test('a conversation\'s strip is saved across a restart; a page\'s strip is not', () => {
    const router = new RouterStore()
    router.poolDestinationKey = () => 'session:s_1'
    router.syncDestination()
    router.navigate(REVIEW)
    router.navigate(TASKS)
    router.navigate(TASK)
    router.navigate(PRS)

    const saved = router.persistedStrips
    expect(saved.map((strip) => strip.destinationKey)).toEqual(['session:s_1'])

    const restored = new RouterStore()
    restored.poolDestinationKey = () => 'session:s_1'
    restored.restoreStrips(saved)
    restored.syncDestination()
    expect(stripOf(restored)).toEqual(['review'])
  })
})

describe('Run on device', () => {
  // Device Panel Fixes (task 01M46E8SGHZE08W88BCXEW0TFM): every entry point
  // that opens Devices reuses one Devices tab, and the conversation stays.
  const paletteDevices: RouteRef = { name: 'devices', params: {} }
  const runDevices: RouteRef = { name: 'devices', params: { sessionId: 's_1', serverId: 'local' } }

  test('Devices opened from the palette, then by a run, is one tab with the run\'s session', () => {
    const router = new RouterStore()
    router.navigate(paletteDevices)

    router.navigate(runDevices)

    expect(router.companionPane?.surfaces).toEqual([runDevices])
    expect(router.destination).toEqual(CHAT)
  })

  test('a run started inside the Devices tab keeps the conversation and every other tab', () => {
    // WHY: the click focuses the Devices pane. Before, reopening from there
    // replaced the conversation and showed Devices in both panes.
    const router = new RouterStore()
    router.navigate(TASK)
    const companion = router.navigate(paletteDevices)
    router.focusPane(companion.id)

    router.navigate(runDevices)
    router.navigate(runDevices)

    expect(router.destination).toEqual(CHAT)
    expect(router.panes).toHaveLength(2)
    expect(router.companionPane?.surfaces.map((ref) => ref.name)).toEqual(['task', 'devices'])
    expect(router.companionSurface).toEqual(runDevices)
  })

  test('a Devices tab the user adds from the strip sits beside the first, and a run still reuses the first', () => {
    // WHY: one Devices tab per strip meant "+ → Devices" only refocused the
    // open one, so a second device could never be watched in its own tab.
    const extraDevices: RouteRef = { name: 'devices', params: { surfaceId: 'extra1' } }
    const router = new RouterStore()
    router.navigate(paletteDevices)
    router.navigate(extraDevices)

    router.navigate(runDevices)

    expect(router.companionPane?.surfaces).toEqual([runDevices, extraDevices])
    expect(router.companionSurface).toEqual(runDevices)
  })

  test('an extra Devices tab keeps its id through the address', () => {
    const extraDevices: RouteRef = { name: 'devices', params: { sessionId: 's_1', serverId: 'local', surfaceId: 'extra1' } }
    expect(parseRef(serializeRef(extraDevices))).toEqual(extraDevices)
    expect(parseRef(serializeRef(runDevices))).toEqual(runDevices)
  })
})

describe('opens the user did not ask for', () => {
  test('beside another surface, an automatic open waits in the background, marked unread', () => {
    // WHY: an agent opening the browser must not take the task page out from
    // under the person reading it.
    const router = new RouterStore()
    router.navigate(TASK)
    const browser: RouteRef = { name: 'browser', params: {} }

    router.navigate(browser, { automatic: true })

    expect(router.companionSurface?.name).toBe('task')
    expect(router.isSurfaceUnread(browser)).toBe(true)

    router.activateSurface(1)
    expect(router.isSurfaceUnread(browser)).toBe(false)
  })

  test('with nothing beside the destination, an automatic open shows at once', () => {
    const router = new RouterStore()
    const browser: RouteRef = { name: 'browser', params: {} }

    router.navigate(browser, { automatic: true })

    expect(router.companionSurface?.name).toBe('browser')
    expect(router.isSurfaceUnread(browser)).toBe(false)
  })
})

describe('closing the leading pane', () => {
  const DRAFT: RouteRef = { name: 'draft', params: { draftId: 'd_1' } }

  test('rests on whatever the workspace names as home, however it closes', () => {
    // WHY: every page's own close button, the palette toggle and the pane
    // chrome all reach the router by a different method. The bug — a closed
    // page dropping an empty workspace onto a bare chat — has to be fixed once,
    // below all of them, or it comes back with the next call site.
    for (const close of [
      (router: InstanceType<typeof RouterStore>) => router.closePane(router.leadingPane.id),
      (router: InstanceType<typeof RouterStore>) => router.close('tasks'),
    ]) {
      const router = new RouterStore()
      router.leadingHome = () => DRAFT
      router.navigate(TASKS)

      close(router)

      expect(router.destination).toEqual(DRAFT)
    }
  })

  test('closing in the companion pane closes its surface and never asks the workspace', () => {
    // WHY: answering may mint a draft, so a surface closing must not cost the
    // workspace one.
    const router = new RouterStore()
    let asked = 0
    router.leadingHome = () => { asked += 1; return DRAFT }
    const companion = router.navigate(PLAN)

    router.closePane(companion.id)

    expect(asked).toBe(0)
    expect(router.companionPane).toBeNull()
    expect(router.destination).toEqual(CHAT)
  })

  test('a conversation surface moved to main becomes the destination', () => {
    const router = new RouterStore()
    router.navigate(TASK)
    router.navigate(DRAFT, { target: 'companion' })

    router.moveSurfaceToMain(1)

    expect(router.destination).toEqual(DRAFT)
  })
})

describe('closing Settings', () => {
  const DRAFT: RouteRef = { name: 'draft', params: { draftId: 'd_home' } }
  const settings = (tab: 'general' | 'tools' | 'voice'): RouteRef => ({ name: 'settings', params: { tab } })

  test('returns to the main page it was opened from', () => {
    // WHY: Settings is a detour. Opened from Tasks, closing it must put the
    // user back on Tasks, not drop them into the conversation.
    const router = new RouterStore()
    router.leadingHome = () => DRAFT
    router.navigate(TASKS)
    router.navigate(settings('general'))

    router.close('settings')

    expect(router.destination).toEqual(TASKS)
  })

  test('moving between settings tabs does not change where it returns', () => {
    // WHY: each tab replaces Settings with itself. If that counted as the step
    // in, closing would land on another settings tab instead of the way out.
    const router = new RouterStore()
    router.leadingHome = () => DRAFT
    router.navigate(PRS)
    router.navigate(settings('general'))
    router.navigate(settings('tools'), { replace: true })
    router.navigate(settings('voice'), { replace: true })

    router.close('settings')

    expect(router.destination).toEqual(PRS)
  })

  test('with nothing remembered it rests on home', () => {
    // WHY: an app opened straight into Settings has no main page behind it.
    const router = new RouterStore(new MemoryRouteHistory('/settings/tools'))
    router.leadingHome = () => DRAFT

    router.close('settings')

    expect(router.destination).toEqual(DRAFT)
  })

  test('a remembered route that can no longer show falls back to home', () => {
    // WHY: the conversation the user left may have closed while Settings was
    // open. Returning to it would show an empty pool or a dead draft.
    const router = new RouterStore()
    const pinned: RouteRef = { name: 'chat', params: { sessionId: 'sess_gone' } }
    router.leadingHome = () => DRAFT
    router.canReturnTo = (ref) => ref.name !== 'chat'
    router.navigate(pinned)
    router.navigate(settings('general'))

    router.close('settings')

    expect(router.destination).toEqual(DRAFT)
  })

  test('a later visit does not return to an earlier one\'s page', () => {
    // WHY: the remembered route belongs to one visit. Opened again from the
    // conversation, Settings must not send the user back to Tasks.
    const router = new RouterStore()
    router.leadingHome = () => DRAFT
    router.navigate(TASKS)
    router.navigate(settings('general'))
    router.navigate(CHAT)
    router.navigate(settings('general'))

    router.close('settings')

    expect(router.destination).toEqual(CHAT)
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

describe('the insights route', () => {
  // WHY: a turn and a session open in the same panel from the same route
  // name, so the segment grammar has to keep them apart. "session" is a
  // reserved first segment; a trace id is a hex hash and never reads that.
  test('a session page round-trips beside a turn and a span', () => {
    const turn: RouteRef = { name: 'insights', params: { traceId: 'abc123' } }
    const span: RouteRef = { name: 'insights', params: { traceId: 'abc123', spanId: 'sp9' } }
    const session: RouteRef = { name: 'insights', params: { sessionId: 's-1' } }
    for (const ref of [turn, span, session]) {
      expect(parseRef(serializeRef(ref))).toEqual(ref)
    }
    expect(serializeRef(session)).toBe('insights/session/s-1')
  })

  test('a bare "session" segment is the list, not a page with no session', () => {
    expect(parseRef('insights/session')).toEqual({ name: 'insights', params: {} })
  })

  // WHY: the conversation's action row opens Insights beside the conversation
  // it measures. Opening a turn from that console must update it there, not
  // stack a second console in the strip or take the leading pane.
  test('opens as one surface beside the conversation and updates in place', () => {
    const router = new RouterStore()
    const pane = router.navigate({ name: 'insights', params: {} }, { target: 'companion' })
    router.navigate({ name: 'insights', params: { traceId: 'abc123' } }, { target: 'companion' })

    expect(router.destination.name).toBe('chat')
    expect(pane.surfaces).toEqual([{ name: 'insights', params: { traceId: 'abc123' } }])
    expect(router.at('insights')).toBe(true)
  })

  test('still opens as the destination by default', () => {
    const router = new RouterStore()
    router.navigate({ name: 'insights', params: {} })

    expect(router.destination.name).toBe('insights')
    expect(router.companionPane).toBeNull()
  })
})

describe('reporting what the panes show', () => {
  // WHY: a restored conversation loads only when something shows it, and the
  // workspace learns that from this report. A change that skips it — a chat
  // surface opened beside a task, a strip tab, browser back — leaves that
  // conversation on screen with an empty transcript.
  test('every change to the location is reported, history included', () => {
    const router = new RouterStore()
    let reports = 0
    router.onLocationChanged = () => { reports += 1 }

    router.navigate(TASK)
    router.navigate({ name: 'chat', params: { sessionId: 's-2' } }, { target: 'companion' })
    router.activateSurface(0)
    expect(reports).toBe(3)

    router.back()
    expect(reports).toBe(4)
  })
})
