import { describe, expect, test } from 'bun:test'
import { EMPTY_SESSION_VIEW, UNSETTLED_SESSION_STATE } from '@solus/contracts/session-state'
import type { HubNotification } from '@solus/contracts/notification-hub'
import type { SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import { nativeDestination } from '../../apps/mobile/src/features/notifications/lib/native-destinations'
import { ShareArrivals, sharedNoticeMessage } from '../../apps/mobile/src/features/threads/shared-with-you'
import { ThreadDirectory, threadKey, type SolusThreadShell } from '../../apps/mobile/src/features/threads/thread-directory'
import { buildThreadListV2Items, buildThreadListV2ListItems, type ThreadListV2Facts } from '../../apps/mobile/src/features/threads/threadListV2'

// docs/plans/shared-with-you.md §2 and §6: on the phone, a session another
// person owns is in Shared with you and in no other group, a new direct share
// shows one notice (not a burst when the app opens), and a share notification
// opens the session on the host that sent it.

const NOW = Date.UTC(2026, 9, 27, 12, 0)
const HOUR = 60 * 60 * 1000

function record(sessionId: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId, organizationId: 'org', publication: 'local', ownerKey: 'me', provider: 'claude-code',
    projectPath: '/repo', projectRemote: null, runnerHostId: null, title: `Session ${sessionId}`, customTitle: null,
    status: 'idle', model: null, reasoningEffort: null, parentSessionId: null, rootSessionId: null,
    createdAt: NOW - HOUR, lastActivityAt: NOW - HOUR, size: 0, cwd: '/repo', slug: null, isWorktree: false,
    branch: null, projectRoot: null, delegation: null, role: 'owner', ...extra,
  }
}

/** Another person's session that a direct share gave the reader. */
function sharedRecord(sessionId: string, grantedAt: number, extra: Partial<SessionRecord> = {}): SessionRecord {
  return record(sessionId, { ownerKey: 'ana', role: 'editor', sharedBy: 'ana', grantedAt, ...extra })
}

function shell(sessionId: string, value: SessionRecord): SolusThreadShell {
  return { key: threadKey('h', sessionId), hostId: 'h', hostLabel: 'Mac', record: value }
}

const NO_FACTS: ThreadListV2Facts = { states: new Map(), views: new Map(), liveStatus: new Map(), pullRequests: new Map() }

function layout(threads: SolusThreadShell[], facts: ThreadListV2Facts = NO_FACTS) {
  const built = buildThreadListV2Items({ threads, facts, hostId: null, searchQuery: '', now: NOW, settledShelfExpanded: true, snoozedShelfExpanded: true })
  const rows = buildThreadListV2ListItems({
    items: built.items, facts,
    sharedCount: built.sharedCount, sharedHeaderIndex: built.sharedHeaderIndex,
    snoozedCount: built.snoozedCount, snoozedShelfExpanded: true, snoozedShelfHeaderIndex: built.snoozedShelfHeaderIndex,
    settledCount: built.settledCount, settledShelfExpanded: true, settledShelfHeaderIndex: built.settledShelfHeaderIndex,
  })
  return rows.map((row) => row.type === 'v2-thread' ? row.item.thread.record.sessionId : row.type)
}

describe('Shared with you group', () => {
  test('personal completion removes even the selected shared row, and Undo returns it', () => {
    const thread = shell('shared', sharedRecord('shared', NOW))
    const completed: ThreadListV2Facts = {
      ...NO_FACTS,
      views: new Map([[thread.key, { ...EMPTY_SESSION_VIEW, settledAt: NOW }]]),
    }
    expect(layout([thread], completed)).toEqual([])
    const selected = buildThreadListV2Items({ threads: [thread], facts: completed, hostId: null, searchQuery: '', now: NOW, selectedThreadKey: thread.key })
    expect(selected.items).toEqual([])
    expect(selected.sharedCount).toBe(0)
    expect(layout([thread], { ...NO_FACTS, views: new Map([[thread.key, EMPTY_SESSION_VIEW]]) }))
      .toEqual(['v2-shared-section', 'shared'])
    // A fresh read carries the same personal completion on the record.
    expect(layout([shell('shared', { ...thread.record, view: { ...EMPTY_SESSION_VIEW, settledAt: NOW } })])).toEqual([])
  })

  test('another person\'s session is in Shared with you, after the active rows and before the shelves, and in no other group', () => {
    // WHY: the owner decides the group (§2 rule 1): a shared session that is
    // working, snoozed, or settled must not mix with the reader's own work.
    const mine = shell('mine', record('mine'))
    const mySettled = shell('my-settled', record('my-settled'))
    const sharedRunning = shell('shared-running', sharedRecord('shared-running', NOW - 3 * HOUR, { status: 'running' }))
    const sharedSettled = shell('shared-settled', sharedRecord('shared-settled', NOW - 2 * HOUR))
    const sharedSnoozed = shell('shared-snoozed', sharedRecord('shared-snoozed', NOW - HOUR))
    const facts: ThreadListV2Facts = {
      ...NO_FACTS,
      states: new Map([
        [mySettled.key, { ...UNSETTLED_SESSION_STATE, settledAt: NOW - HOUR, settledBy: 'person' as const }],
        [sharedSettled.key, { ...UNSETTLED_SESSION_STATE, settledAt: NOW - HOUR, settledBy: 'person' as const }],
      ]),
      views: new Map([[sharedSnoozed.key, { ...EMPTY_SESSION_VIEW, snoozedUntil: NOW + HOUR }]]),
    }
    expect(layout([mine, mySettled, sharedRunning, sharedSettled, sharedSnoozed], facts)).toEqual([
      'mine',
      'v2-shared-section', 'shared-snoozed', 'shared-settled', 'shared-running',
      'v2-settled-shelf', 'my-settled',
    ])
  })

  test('shared rows read newest grant first, not newest activity', () => {
    const older = shell('older', sharedRecord('older', NOW - 2 * HOUR, { lastActivityAt: NOW }))
    const newer = shell('newer', sharedRecord('newer', NOW - HOUR, { lastActivityAt: NOW - 5 * HOUR }))
    expect(layout([older, newer])).toEqual(['v2-shared-section', 'newer', 'older'])
  })

  test('a session the reader owns, or one from a host that names no role, has no Shared with you group', () => {
    expect(layout([shell('a', record('a')), shell('b', record('b', { role: undefined }))])).toEqual(['a', 'b'])
  })

  test('an archived shared session leaves the group, as the reader\'s own session leaves the list', () => {
    const archived = shell('gone', sharedRecord('gone', NOW))
    const facts: ThreadListV2Facts = { ...NO_FACTS, views: new Map([[archived.key, { ...EMPTY_SESSION_VIEW, archivedAt: NOW }]]) }
    expect(layout([archived], facts)).toEqual([])
  })
})

describe('new share notice', () => {
  test('the first read of a host only sets the mark; a later read shows only grants newer than it', () => {
    // WHY: opening the app must not show a burst of shares already in the list (§5).
    const arrivals = new ShareArrivals()
    expect(arrivals.take('h', [sharedRecord('a', 10), record('mine')])).toEqual([])
    expect(arrivals.take('h', [sharedRecord('a', 10)])).toEqual([])
    const raised = sharedRecord('a', 20)
    const added = sharedRecord('b', 30)
    expect(arrivals.take('h', [raised, added, record('mine', { grantedAt: 40 })]).map((entry) => entry.sessionId)).toEqual(['b', 'a'])
    expect(arrivals.take('h', [raised, added])).toEqual([])
  })

  test('each host keeps its own mark, and a forgotten host starts again without a notice', () => {
    const arrivals = new ShareArrivals()
    arrivals.take('mac', [sharedRecord('a', 50)])
    expect(arrivals.take('studio', [sharedRecord('b', 10)])).toEqual([])
    arrivals.forget('mac')
    expect(arrivals.take('mac', [sharedRecord('c', 60)])).toEqual([])
  })

  test('the directory tells its listeners about a new share after a read, not about the shares the first read found', async () => {
    const answer = { records: [sharedRecord('a', 10)] }
    const connection = {
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async (filter: SessionRecordListFilter) => ({ records: filter.scope === 'all' ? [] : structuredClone(answer.records), indexing: false }),
        listProjects: async () => [],
      },
    }
    const host = { id: 'h', label: 'Mac' }
    // SAFETY: the directory reads only these members of the registry and the connection.
    const directory = new ThreadDirectory({ host: () => host, hosts: () => [host] } as never, () => connection as never)
    const heard: string[][] = []
    directory.subscribeShares((threads) => heard.push(threads.map((thread) => thread.record.sessionId)))
    await directory.load('h')
    expect(heard).toEqual([])
    answer.records = [sharedRecord('a', 10), sharedRecord('b', 20, { customTitle: 'Fix login' })]
    await directory.load('h')
    expect(heard).toEqual([['b']])
    expect(sharedNoticeMessage(directory.thread('h', 'b')!.record, 'Fix login')).toBe('Shared with you: Fix login · Can edit')
  })
})

describe('share notifications on the phone', () => {
  const resource = { kind: 'session' as const, sessionId: 's1' }
  const notification = (facts: HubNotification['facts']) => ({ resource, facts })

  test('a share opens the session; a removed share opens nothing', () => {
    // WHY: after the owner removes access, opening the session only shows "no access".
    expect(nativeDestination(notification({ kind: 'session.shared', role: 'viewer' }))).toEqual({ kind: 'thread', sessionId: 's1' })
    expect(nativeDestination(notification({ kind: 'session.unshared' }))).toEqual({ kind: 'none' })
  })
})
