import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from 'bun:test'
import { EMPTY_SESSION_VIEW, UNSETTLED_SESSION_STATE, type SessionState, type SessionView } from '@solus/contracts/session-state'
import type { SessionRecord } from '@solus/contracts/types'
import { join } from 'node:path'
import { threadKey, type SolusThreadShell } from '../../apps/mobile/src/features/threads/thread-directory'
import { snoozeWakeLabel } from '../../apps/mobile/src/features/threads/thread-snooze'
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  threadListV2TimeLabel,
  type ThreadListV2Facts,
  type ThreadListV2ThreadListItem,
} from '../../apps/mobile/src/features/threads/threadListV2'

const appState = {
  current: 'active',
  listeners: new Set<(state: string) => void>(),
  set(next: string) {
    this.current = next
    for (const listener of this.listeners) listener(next)
  },
}
mock.module('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.current
    },
    addEventListener: (_event: 'change', listener: (state: string) => void) => {
      appState.listeners.add(listener)
      return { remove: () => appState.listeners.delete(listener) }
    },
  },
}))

// The visibility test renders a hook host with react-dom, which carries its
// own React copy; the app's hooks must use that copy for the dispatcher to match.
const domReact = join(import.meta.dir, '../../node_modules/react-dom/node_modules/react/index.js')
mock.module('react', () => require(domReact))

const { ThreadListClock, useThreadListClockWhile, useThreadListTime } = await import('../../apps/mobile/src/features/threads/thread-list-clock')

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><div id="root"></div>')
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.UTC(2026, 9, 4, 12, 0, 30)

// Bun's fake timers do not move `Date.now`, so the wall clock moves with them here.
let wallClock = NOW
function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    wallClock += 1_000
    jest.advanceTimersByTime(1_000)
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  wallClock = NOW
  spyOn(Date, 'now').mockImplementation(() => wallClock)
  appState.current = 'active'
  appState.listeners.clear()
})

afterEach(() => {
  jest.useRealTimers()
  mock.restore()
})

describe('the thread list clock', () => {
  test('reads the time at once, then ticks just after each minute boundary', () => {
    const clock = new ThreadListClock()
    const ticks: number[] = []
    const unsubscribe = clock.subscribe(() => ticks.push(clock.now()))
    const stop = clock.start()
    expect(ticks).toEqual([NOW])
    advance(30_000)
    expect(ticks).toEqual([NOW])
    advance(1_000)
    expect(ticks).toEqual([NOW, NOW + 31_000])
    advance(60_000)
    expect(ticks).toHaveLength(3)
    stop()
    advance(5 * MINUTE)
    expect(ticks).toHaveLength(3)
    expect(jest.getTimerCount()).toBe(0)
    unsubscribe()
  })

  test('two runs share one timer, and a list stops it only when the last run stops', () => {
    // WHY: Home starts the clock on focus; a double focus must not double the ticks.
    const clock = new ThreadListClock()
    const ticks: number[] = []
    clock.subscribe(() => ticks.push(clock.now()))
    const stopFirst = clock.start()
    const stopSecond = clock.start()
    expect(jest.getTimerCount()).toBe(1)
    stopFirst()
    stopFirst()
    advance(MINUTE)
    expect(ticks).toHaveLength(2)
    stopSecond()
    expect(jest.getTimerCount()).toBe(0)
  })

  test('sleeps in the background and shows the true time on return', () => {
    const clock = new ThreadListClock()
    const stop = clock.start()
    appState.set('background')
    expect(jest.getTimerCount()).toBe(0)
    advance(3 * HOUR)
    appState.set('active')
    expect(clock.now()).toBe(NOW + 3 * HOUR)
    appState.set('active')
    expect(jest.getTimerCount()).toBe(1)
    stop()
    expect(appState.listeners.size).toBe(0)
  })

  test('says when it runs, so a row\'s second clock stops with it; a minute tick is not a change', () => {
    // WHY: a "Working 26s" label ticks each second (pingdotgg/t3code#21394).
    // It must stop while the list is hidden or the app sleeps, as the minute
    // clock does, and a minute tick must not wake every row's second clock.
    const clock = new ThreadListClock()
    const changes: boolean[] = []
    clock.subscribeRunning(() => changes.push(clock.isRunning()))
    expect(clock.isRunning()).toBe(false)
    const stop = clock.start()
    expect(changes).toEqual([true])
    advance(3 * MINUTE)
    expect(changes).toEqual([true])
    appState.set('background')
    appState.set('active')
    expect(changes).toEqual([true, false, true])
    stop()
    expect(changes).toEqual([true, false, true, false])
    expect(clock.isRunning()).toBe(false)
  })
})

describe('the iPad sidebar clock follows visibility, not the mount', () => {
  // WHY: AdaptiveWorkspaceLayout keeps a hidden sidebar mounted at zero width.
  // A clock tied to the mount would re-render its rows every minute unseen.
  function SidebarClockHost(props: { readonly clock: InstanceType<typeof ThreadListClock>; readonly visible: boolean; readonly renders: string[] }) {
    useThreadListClockWhile(props.clock, props.visible)
    props.renders.push(useThreadListTime(props.clock, (now) => new Date(now).toISOString()))
    return null
  }

  test('a hidden pane does not tick; shown again it reads the time at once; unmount releases the clock', () => {
    const clock = new ThreadListClock()
    const renders: string[] = []
    const root = createRoot(dom.window.document.getElementById('root')!)
    const render = (visible: boolean) => act(() => root.render(createElement(SidebarClockHost, { clock, visible, renders })))

    render(true)
    expect(jest.getTimerCount()).toBe(1)
    advance(MINUTE)
    const shown = renders.length

    render(false)
    expect(jest.getTimerCount()).toBe(0)
    expect(appState.listeners.size).toBe(0)
    const hidden = renders.length
    act(() => advance(2 * HOUR))
    act(() => appState.set('background'))
    act(() => appState.set('active'))
    expect(renders.length).toBe(hidden)

    render(true)
    expect(renders.at(-1)).toBe(new Date(NOW + MINUTE + 2 * HOUR).toISOString())
    expect(jest.getTimerCount()).toBe(1)
    expect(shown).toBeGreaterThan(1)

    act(() => root.unmount())
    expect(jest.getTimerCount()).toBe(0)
    expect(appState.listeners.size).toBe(0)
  })
})

function shell(sessionId: string, extra: Partial<SessionRecord>): SolusThreadShell {
  const record: SessionRecord = {
    sessionId, organizationId: 'local', publication: 'local', ownerKey: 'local:test', provider: 'claude-code',
    projectPath: '/repo', projectRemote: null, runnerHostId: null, title: `Session ${sessionId}`, customTitle: null,
    status: 'idle', model: null, reasoningEffort: null, parentSessionId: null, rootSessionId: null,
    createdAt: NOW - HOUR, lastActivityAt: NOW - HOUR, size: 0, cwd: '/repo', slug: null, isWorktree: false,
    branch: null, projectRoot: null, delegation: null, ...extra,
  }
  return { key: threadKey('host', sessionId), hostId: 'host', hostLabel: 'host', record }
}

/** The baseline fixture (plans/t3-performance-review-2026-10-19/native-performance-baseline.test.ts): 20 active, 10 settled, 5 snoozed. */
function sidebarFixture() {
  const threads: SolusThreadShell[] = []
  const states = new Map<string, SessionState>()
  const views = new Map<string, SessionView>()
  for (let index = 0; index < 35; index++) {
    const thread = shell(`s${index}`, { createdAt: NOW - index * HOUR, lastActivityAt: NOW - 30_000 - index * 83 * MINUTE })
    threads.push(thread)
    if (index >= 20 && index < 30) states.set(thread.key, { ...UNSETTLED_SESSION_STATE, settledAt: NOW - index * HOUR })
    if (index >= 30) views.set(thread.key, { ...EMPTY_SESSION_VIEW, snoozedUntil: NOW + (index - 29) * 37 * MINUTE })
  }
  const facts: ThreadListV2Facts = { states, views, liveStatus: new Map(), pullRequests: new Map() }
  return { threads, facts }
}

/** What a row reads from the clock (ThreadListV2Row): it re-renders when one of these changes. */
function rowAnswers(item: ThreadListV2ThreadListItem, now: number) {
  return [
    threadListV2TimeLabel(item.timeLabelAt, now),
    item.snoozedUntil === null ? undefined : snoozeWakeLabel(item.snoozedUntil, now),
    // A row whose menu offers snooze presets shows their times, so it reads every tick.
    item.snoozable ? now : null,
  ]
}

describe('a minute tick on the thread list', () => {
  test('rebuilds no list items; only rows whose time text or snooze menu moved read a new answer', () => {
    const { threads, facts } = sidebarFixture()
    const layout = buildThreadListV2Items({ threads, facts, hostId: null, searchQuery: '', now: Date.now(), snoozedShelfExpanded: true, settledShelfExpanded: true })
    const items = buildThreadListV2ListItems({ ...layout, items: layout.items, facts, snoozedShelfExpanded: true, settledShelfExpanded: true })
    const rows = items.filter((item): item is ThreadListV2ThreadListItem => item.type === 'v2-thread')
    // The same minute pair as the baseline probe, at the clock's tick times.
    const tick = Math.floor(NOW / MINUTE) * MINUTE + 50
    const next = tick + MINUTE
    const changed = rows.filter((row) => JSON.stringify(rowAnswers(row, tick)) !== JSON.stringify(rowAnswers(row, next)))
    const labelChanged = rows.filter((row) => JSON.stringify(rowAnswers(row, tick).slice(0, 2)) !== JSON.stringify(rowAnswers(row, next).slice(0, 2)))
    const quiet = rows.filter((row) => !row.snoozable && !changed.includes(row))
    console.log(JSON.stringify({
      probe: 'thread-list-minute-tick', rows: rows.length, listItems: items.length,
      perTick: { partitionBuilds: 0, listItemBuilds: 0, parentPaneRenders: 0, unequalItems: 0, rowRerenders: changed.length, rowsWithChangedLabelText: labelChanged.length, rowsWithSnoozeMenu: rows.filter((row) => row.snoozable).length, rowsLeftAlone: quiet.length },
    }))
    // The snoozed shelf counts down without the list; its rows offer no presets.
    expect(rows.filter((row) => row.snoozedUntil !== null)).toHaveLength(5)
    expect(quiet.length).toBeGreaterThan(0)
    expect(changed.length).toBe(rows.filter((row) => row.snoozable).length + labelChanged.filter((row) => !row.snoozable).length)
  })

  test('a snooze still ends at its exact wake time, not on a minute tick', () => {
    const { threads, facts } = sidebarFixture()
    const build = (now: number) => buildThreadListV2Items({ threads, facts, hostId: null, searchQuery: '', now, snoozedShelfExpanded: true })
    const wakeAt = build(NOW).nextSnoozeWakeAt!
    expect(wakeAt).toBe(NOW + 37 * MINUTE)
    expect(build(wakeAt - 1).snoozedCount).toBe(5)
    // The list arms its timer 50 ms past the wake time and partitions again.
    expect(build(wakeAt + 50).snoozedCount).toBe(4)
  })
})
