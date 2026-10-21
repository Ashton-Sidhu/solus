import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { EMPTY_SESSION_VIEW, type SessionView } from '@solus/contracts/session-state'
import type { SessionRecord, SessionStatus } from '@solus/contracts/types'
import { THREAD_UNDO_NOTICE_MS, ThreadUndoNotices } from '../../apps/mobile/src/features/home/thread-undo-notice'
import { threadKey, type SolusThreadShell } from '../../apps/mobile/src/features/threads/thread-directory'
import { ThreadListState, type ThreadListConnection } from '../../apps/mobile/src/features/threads/thread-list-state'
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  threadListV2ListItemsAreEqual,
  type ThreadListV2Facts,
  type ThreadListV2ThreadListItem,
} from '../../apps/mobile/src/features/threads/threadListV2'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'

const NOW = Date.UTC(2026, 9, 4, 12, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function shell(sessionId: string, extra: Partial<SessionRecord> = {}): SolusThreadShell {
  const record: SessionRecord = {
    sessionId, organizationId: 'local', publication: 'local', ownerKey: 'local:test', provider: 'claude-code',
    projectPath: '/repo', projectRemote: null, runnerHostId: null, title: `Session ${sessionId}`, customTitle: null,
    status: 'idle', model: null, reasoningEffort: null, parentSessionId: null, rootSessionId: null,
    createdAt: NOW - HOUR, lastActivityAt: NOW - HOUR, size: 0, cwd: '/repo', slug: null, isWorktree: false,
    branch: null, projectRoot: null, delegation: null, ...extra,
  }
  return { key: threadKey('h', sessionId), hostId: 'h', hostLabel: 'h', record }
}

function facts(input: { views?: Map<string, SessionView>; live?: Map<string, SessionStatus>; since?: Map<string, number> } = {}): ThreadListV2Facts {
  return { states: new Map(), views: input.views ?? new Map(), liveStatus: input.live ?? new Map(), statusSince: input.since, pullRequests: new Map() }
}

function rows(threads: SolusThreadShell[], listFacts: ThreadListV2Facts, now: number): ThreadListV2ThreadListItem[] {
  const layout = buildThreadListV2Items({ threads, facts: listFacts, hostId: null, searchQuery: '', now })
  return buildThreadListV2ListItems({ items: layout.items, facts: listFacts }).filter(
    (item): item is ThreadListV2ThreadListItem => item.type === 'v2-thread',
  )
}

describe('a thread row says Woke until the person sees it (pingdotgg/t3code#21394)', () => {
  const thread = shell('woke')
  const wakeAt = NOW + 30_000
  const snoozed = facts({ views: new Map([[thread.key, { ...EMPTY_SESSION_VIEW, snoozedUntil: wakeAt }]]) })

  test('at the exact wake the row returns marked Woke in place of its age', () => {
    // WHY: the list re-partitions at the exact wake time, not at a minute
    // tick, and the row leaves the shelf already marked.
    const before = rows([thread], snoozed, NOW)
    const after = rows([thread], snoozed, wakeAt + 7_500)
    expect(before).toHaveLength(0)
    expect(after[0]!.item.wokeAt).toBe(wakeAt)
    expect(after[0]!.timeLabelAt).toBeNull()
  })

  test('clearing the ended snooze, which opening or dismissing does, removes the mark', () => {
    // WHY: the host keeps an ended snooze until the person sees the thread,
    // as desktop's woken row does; the clear is the acknowledgement.
    const woke = rows([thread], snoozed, wakeAt + MINUTE)[0]!
    const cleared = rows([thread], facts({ views: new Map([[thread.key, EMPTY_SESSION_VIEW]]) }), wakeAt + MINUTE)[0]!
    expect(cleared.item.wokeAt ?? null).toBeNull()
    expect(cleared.timeLabelAt).toBe(thread.record.lastActivityAt)
    expect(threadListV2ListItemsAreEqual(woke, cleared)).toBe(false)
  })

  test('a settled row does not say Woke', () => {
    const settled: ThreadListV2Facts = { ...snoozed, states: new Map([[thread.key, { settledAt: NOW, settledBy: 'person' }]]) }
    expect(rows([thread], settled, wakeAt + MINUTE)[0]!.item.wokeAt ?? null).toBeNull()
  })
})

describe('Working and Waiting rows count from when the status began (pingdotgg/t3code#21394)', () => {
  function fakeHost() {
    const events = new HostEventSubscriber()
    const connection: ThreadListConnection = {
      events,
      onReset: () => () => {},
      api: {
        sessionPullRequests: async () => [],
        sessionPullRequestWatch: async () => 'started' as const,
        sessionUpdate: async () => ({}),
        setSessionTitle: async () => {},
        setSessionReadState: async (_sessionId, viewedAt) => viewedAt,
      },
    }
    const status = (sessionId: string, value: SessionStatus, at: number) =>
      events.receive({ type: 'session.statusChanged', payload: { sessionId, agentSessionId: null, status: value, at }, occurredAt: at })
    return { connection, status }
  }

  test('connecting then running is one Working; a new turn starts the count again', () => {
    // WHY: the label is the run's age. A provider that connects first must not
    // reset it, and a later turn must not show the earlier turn's age.
    const host = fakeHost()
    const list = new ThreadListState(() => host.connection, memoryKeyValueStore())
    list.follow('h')
    const key = threadKey('h', 's')
    host.status('s', 'connecting', NOW)
    host.status('s', 'running', NOW + 2_000)
    expect(list.facts().statusSince?.get(key)).toBe(NOW)
    host.status('s', 'idle', NOW + MINUTE)
    host.status('s', 'running', NOW + 2 * MINUTE)
    expect(list.facts().statusSince?.get(key)).toBe(NOW + 2 * MINUTE)
    host.status('s', 'background', NOW + 3 * MINUTE)
    expect(list.facts().statusSince?.get(key)).toBe(NOW + 3 * MINUTE)
  })

  test('only a Working or Waiting row carries a start, and only one this client saw begin', () => {
    // WHY: a row that shows no status must not tick, and a run that started
    // before this client connected has no true start to count from.
    const working = shell('w')
    const waiting = shell('b')
    const ready = shell('r')
    const unseen = shell('u')
    const listFacts = facts({
      live: new Map<string, SessionStatus>([[working.key, 'running'], [waiting.key, 'background'], [ready.key, 'idle'], [unseen.key, 'running']]),
      since: new Map([[working.key, NOW - 26_000], [waiting.key, NOW - MINUTE], [ready.key, NOW - HOUR]]),
    })
    const byKey = new Map(rows([working, waiting, ready, unseen], listFacts, NOW).map((row) => [row.item.thread.key, row]))
    expect(byKey.get(working.key)!.statusStartedAt).toBe(NOW - 26_000)
    expect(byKey.get(waiting.key)!.statusStartedAt).toBe(NOW - MINUTE)
    expect(byKey.get(ready.key)!.statusStartedAt).toBeNull()
    expect(byKey.get(unseen.key)!.statusStartedAt).toBeNull()
  })
})

describe('thread list Undo (pingdotgg/t3code#21401)', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('Undo runs the inverse once and closes the notice', () => {
    // WHY: a double press must not un-settle twice or fight a later action.
    const notices = new ThreadUndoNotices()
    let undone = 0
    notices.show({ action: 'Settled', threadKey: 'a', undo: () => { undone += 1 } })
    notices.undo()
    notices.undo()
    expect(undone).toBe(1)
    expect(notices.current()).toBeNull()
  })

  test('Undo is offered for five seconds, and a newer action takes the slot', () => {
    const notices = new ThreadUndoNotices()
    notices.show({ action: 'Settled', threadKey: 'a', undo: () => {} })
    jest.advanceTimersByTime(THREAD_UNDO_NOTICE_MS - 1_000)
    notices.show({ action: 'Archived', threadKey: 'b', undo: () => {} })
    jest.advanceTimersByTime(THREAD_UNDO_NOTICE_MS - 1)
    expect(notices.current()?.action).toBe('Archived')
    jest.advanceTimersByTime(1)
    expect(notices.current()).toBeNull()
    expect(jest.getTimerCount()).toBe(0)
  })

  test('a new action on the same thread dismisses its Undo; one on another thread does not', () => {
    // WHY: after a snooze then a wake from the row, Undo would snooze it again.
    const notices = new ThreadUndoNotices()
    notices.show({ action: 'Snoozed', threadKey: 'a', undo: () => {} })
    notices.dismiss('b')
    expect(notices.current()?.threadKey).toBe('a')
    notices.dismiss('a')
    expect(notices.current()).toBeNull()
  })
})
