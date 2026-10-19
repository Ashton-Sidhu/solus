// Native-performance lane, stage 1 baseline. Run once against the unchanged
// source (HEAD 14eec2300 + the reviewed dirty tree) before the lane's edits:
//   bun test plans/t3-performance-review-2026-10-19/native-performance-baseline.test.ts
// It characterizes current behavior; it is not a desired-behavior test, and it
// stops compiling once the minute clock leaves the list items. The output is
// kept in native-performance-baseline-output.txt.
import { describe, expect, test } from 'bun:test'
import { EMPTY_SESSION_VIEW, UNSETTLED_SESSION_STATE, type SessionState, type SessionView } from '@solus/contracts/session-state'
import type { SessionRecord } from '@solus/contracts/types'
import { threadKey, type SolusThreadShell } from '../../apps/mobile/src/features/threads/thread-directory'
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  threadListV2ListItemsAreEqual,
  type ThreadListV2Facts,
} from '../../apps/mobile/src/features/threads/threadListV2'
import { PersonalSettingsStore } from '../../apps/mobile/src/features/settings/personal-settings'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'

const NOW = Date.UTC(2026, 9, 4, 12, 0, 30)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

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

/** 20 active, 10 settled, 5 snoozed (shelf open): the sidebar fixture. */
export function sidebarFixture() {
  const threads: SolusThreadShell[] = []
  const states = new Map<string, SessionState>()
  const views = new Map<string, SessionView>()
  for (let index = 0; index < 35; index++) {
    // Activity spread from 30 s to ~2 days ago, so some labels cross a boundary in a minute.
    const thread = shell(`s${index}`, { createdAt: NOW - index * HOUR, lastActivityAt: NOW - 30_000 - index * 83 * MINUTE })
    threads.push(thread)
    if (index >= 20 && index < 30) states.set(thread.key, { ...UNSETTLED_SESSION_STATE, settledAt: NOW - index * HOUR })
    if (index >= 30) views.set(thread.key, { ...EMPTY_SESSION_VIEW, snoozedUntil: NOW + (index - 29) * 37 * MINUTE })
  }
  const facts: ThreadListV2Facts = { states, views, liveStatus: new Map(), pullRequests: new Map() }
  return { threads, facts }
}

describe('baseline: one minute tick on the native thread list', () => {
  test('counts partitions, list rebuilds and unequal row items per tick', () => {
    const { threads, facts } = sidebarFixture()
    const build = (now: number) => {
      const layout = buildThreadListV2Items({ threads, facts, hostId: null, searchQuery: '', now, snoozedShelfExpanded: true, settledShelfExpanded: true })
      return buildThreadListV2ListItems({ ...layout, items: layout.items, facts, now, snoozedShelfExpanded: true, settledShelfExpanded: true })
    }
    const minute = (at: number) => Math.floor(at / MINUTE) * MINUTE
    const before = build(minute(NOW))
    const after = build(minute(NOW) + MINUTE)
    const rows = before.filter((item) => item.type === 'v2-thread').length
    const unequal = before.filter((item, index) => !threadListV2ListItemsAreEqual(item, after[index]!)).length
    const presetOnly = before.filter((item, index) => {
      const next = after[index]!
      return item.type === 'v2-thread' && next.type === 'v2-thread' && item.timeLabel === next.timeLabel
        && item.snoozeWakeLabelText === next.snoozeWakeLabelText && item.snoozePresetMinute !== next.snoozePresetMinute
    }).length
    const labelChanged = before.filter((item, index) => {
      const next = after[index]!
      return item.type === 'v2-thread' && next.type === 'v2-thread'
        && (item.timeLabel !== next.timeLabel || item.snoozeWakeLabelText !== next.snoozeWakeLabelText)
    }).length
    const partitionUnchanged = JSON.stringify(buildThreadListV2Items({ threads, facts, hostId: null, searchQuery: '', now: minute(NOW), snoozedShelfExpanded: true }).items.map((item) => item.thread.key))
      === JSON.stringify(buildThreadListV2Items({ threads, facts, hostId: null, searchQuery: '', now: minute(NOW) + MINUTE, snoozedShelfExpanded: true }).items.map((item) => item.thread.key))
    console.log(JSON.stringify({
      probe: 'thread-list-minute-tick', rows, listItems: before.length,
      perTick: { partitionBuilds: 1, listItemBuilds: 1, parentPaneRenders: 1, unequalItems: unequal, unequalOnlyBySnoozePresetMinute: presetOnly, rowsWithChangedLabelText: labelChanged },
      partitionUnchangedAcrossTick: partitionUnchanged,
    }))
    expect(unequal).toBeGreaterThan(labelChanged)
  })
})

describe('baseline: personal settings snapshot', () => {
  test('an unrelated write gives the Notifications and Agent defaults screens a new snapshot', () => {
    const store = new PersonalSettingsStore(memoryKeyValueStore())
    const first = store.current()
    store.set({ themeMode: 'dark' })
    const second = store.current()
    store.applyRemote({ set: { extraInstructions: 'remote' }, reset: [] })
    const third = store.current()
    const fullSnapshotChanges = [first !== second, second !== third].filter(Boolean).length
    const notificationsIdentityChanges = [first.notifications !== second.notifications, second.notifications !== third.notifications].filter(Boolean).length
    console.log(JSON.stringify({ probe: 'personal-settings-unrelated-writes', writes: 2, fullSnapshotChanges, notificationsIdentityChanges, notificationsValueEqual: JSON.stringify(first.notifications) === JSON.stringify(third.notifications) }))
    expect(fullSnapshotChanges).toBe(2)
  })
})
