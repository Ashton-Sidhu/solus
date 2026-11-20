import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Message, Session } from '@solus/contracts/types'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import { SessionHostTurns, type SessionCloudHead } from '@solus/client-core/session-heads'
import type { SessionCloudPage } from '@solus/client-core/session-cloud-read'
import { singleHostServerConnections } from './helpers/server-connections-mock'

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: singleHostServerConnections() }))
mock.module('@solus/workspace-ui/contexts/workspace/session-list.store.svelte', () => ({ sessionListStore: {} }))
mock.module('@solus/workspace-ui/contexts/account/account.store.svelte', () => ({ accountStore: { state: { kind: 'signed-out' } } }))
mock.module('@solus/workspace-ui/contexts/workspace/session-transcript', () => ({ loadSessionTranscript: async () => ({ messages: [] }) }))
// Bun runs the store uncompiled: `$state` is the identity.
const runes = globalThis as unknown as { $state?: unknown }
const previousState = runes.$state
runes.$state = <T>(value: T) => value
afterAll(() => { runes.$state = previousState })
const { CloudTranscriptStore } = await import('@solus/workspace-ui/contexts/workspace/cloud-transcript.store.svelte')
type Deps = ConstructorParameters<typeof CloudTranscriptStore>[0]

// The cloud copy of a session that no host shows
// (docs/plans/portable-sessions-cloud.md, Phase 5B): read one turn at a time
// from the Solus API into the tab's own messages, newest first.

const HEAD = 'a'.repeat(40)
const API = 'workspace:org-1'
const CLOUD: SessionCloudHead = { head: HEAD, syncedTurn: 2, lastRunHostId: 'account-studio', runningHostId: null, lastRunServerId: 'studio' }
const API_TURN_0 = { messages: [{ role: 'user', content: 'first', timestamp: 10 }, { role: 'assistant', content: 'one', timestamp: 11 }], before: null, availability: 'available', turnIndex: 0, turnStartedAt: 10 } satisfies SessionCloudPage
const API_TURN_1 = { messages: [{ role: 'user', content: 'second', timestamp: 20 }, { role: 'assistant', content: 'two', timestamp: 21 }], before: 'cursor-0', availability: 'available', turnIndex: 1, turnStartedAt: 20 } satisfies SessionCloudPage

/** A page as the tab's messages: one message for each row, at the row's time. */
const asMessages = (page: SessionHistoryPage): Message[] => page.messages.map((row, index) => ({ id: `${row.content}-${index}`, role: row.role, content: row.content, timestamp: row.timestamp }) as Message)

function harness(opts: { pages?: Record<string, SessionCloudPage | Error>; cloud?: SessionCloudHead | null; diff?: SessionTurnDiff | Error } = {}) {
  const session = {
    id: 'session-1', agentSessionId: 'thread-1', messages: [] as Message[], status: 'idle', loadingHistory: false,
    historyCursor: null, historyTruncated: false, run: { provider: 'codex', location: {} },
  } as unknown as Session
  let tabSession: Session | undefined = session
  let cloud = opts.cloud === undefined ? CLOUD : opts.cloud
  const pages: Record<string, SessionCloudPage | Error> = opts.pages ?? { newest: API_TURN_1, 'cursor-0': API_TURN_0 }
  const reads: string[] = []
  let releaseRead: (() => void) | null = null
  let holdNextRead = false
  const diffReads: number[] = []
  const deps: Deps = {
    sessionFor: () => tabSession,
    apiServerFor: () => (cloud ? API : null),
    cloudHeadFor: () => cloud,
    hostTurnsFor: () => SessionHostTurns.none,
    isSignedIn: () => true,
    isCloudListed: () => true,
    readPage: async (apiServerId, request) => {
      reads.push(`${apiServerId}:${request.before ?? 'newest'}`)
      if (holdNextRead) { holdNextRead = false; await new Promise<void>((resolve) => { releaseRead = resolve }) }
      const page = pages[request.before ?? 'newest']
      if (!page || page instanceof Error) throw page ?? new Error('no page')
      return page
    },
    readDiff: async (_apiServerId, _sessionId, turnIndex) => {
      diffReads.push(turnIndex)
      if (opts.diff instanceof Error) throw opts.diff
      return opts.diff ?? { status: 'available', patch: 'diff --git a/x b/x\n' }
    },
    materialize: async (_tabId, _session, _apiServerId, page) => ({ messages: asMessages(page), before: page.before }),
    rebuildAgentConversations: () => {},
  }
  const store = new CloudTranscriptStore(deps)
  return {
    store, session, reads, diffReads,
    setCloud: (next: SessionCloudHead | null) => { cloud = next },
    closeTab: () => { tabSession = undefined },
    holdNextRead: () => { holdNextRead = true },
    releaseRead: () => releaseRead?.(),
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('opening the cloud copy', () => {
  test('reads the newest turn from the Solus API into the tab, with a cursor to the older one', async () => {
    // WHY: the usual conversation draws the copy, so it must arrive as the tab's
    // own messages and paging state, read from the Solus API, not from a host.
    const { store, session, reads } = harness()
    expect(store.stateFor(session, 'laptop', false)).toEqual({ view: { kind: 'loading' }, shouldRead: true })
    await store.open('tab-1')
    expect(reads).toEqual([`${API}:newest`])
    expect(session.messages.map((message) => message.content)).toEqual(['second', 'two'])
    expect(session.historyCursor).toBe('cursor-0')
    expect(session.historyTruncated).toBe(true)
    expect(store.stateFor(session, 'laptop', false)).toEqual({ view: { kind: 'ready', unavailableTurnCount: 0 }, shouldRead: false })
    expect(store.turnsFor(session.id)).toEqual([{ index: 1, timestamp: 20 }])
  })

  test('older pages read through the reader and add their turns, without reading the newest again', async () => {
    // WHY: history loads by page as the person scrolls up; each page is one request.
    const { store, session, reads } = harness()
    await store.open('tab-1')
    const reader = store.reader(session)
    expect(reader?.serverId).toBe(API)
    await reader?.read('cursor-0')
    expect(reads).toEqual([`${API}:newest`, `${API}:cursor-0`])
    expect(store.turnsFor(session.id)).toEqual([{ index: 1, timestamp: 20 }, { index: 0, timestamp: 10 }])
  })

  test('newest turns with no rows are passed over and counted', async () => {
    // WHY: an old manifest has turns without row files; the copy shows the turns it has and says how many it lacks.
    const missing = { messages: [], before: 'cursor-0', availability: 'not-available', unavailableTurns: [1], turnIndex: 1, turnStartedAt: null } satisfies SessionCloudPage
    const { store, session, reads } = harness({ pages: { newest: missing, 'cursor-0': API_TURN_0 } })
    await store.open('tab-1')
    expect(reads).toEqual([`${API}:newest`, `${API}:cursor-0`])
    expect(session.messages.map((message) => message.content)).toEqual(['first', 'one'])
    expect(store.stateFor(session, 'laptop', false).view).toEqual({ kind: 'ready', unavailableTurnCount: 1 })
  })

  test('a failed read is an error state that a retry reads again', async () => {
    // WHY: an error must not look like an empty session, and "Try again" must work.
    const pages: Record<string, SessionCloudPage | Error> = { newest: new Error('offline') }
    const { store, session, reads } = harness({ pages })
    await store.open('tab-1')
    expect(store.stateFor(session, 'laptop', false).view).toMatchObject({ kind: 'error' })
    pages.newest = API_TURN_1
    await store.reload('tab-1')
    expect(reads).toEqual([`${API}:newest`, `${API}:newest`])
    expect(store.stateFor(session, 'laptop', false).view).toEqual({ kind: 'ready', unavailableTurnCount: 0 })
  })
})

describe('stale guards', () => {
  test('rows a host gave first win, and the copy steps aside', async () => {
    // WHY: two writers to one transcript would show contradictory history.
    const { store, session, holdNextRead, releaseRead } = harness()
    holdNextRead()
    const opening = store.open('tab-1')
    await settle()
    session.messages.push({ id: 'host', role: 'user', content: 'from the host', timestamp: 30 } as Message)
    releaseRead()
    await opening
    expect(session.messages.map((message) => message.content)).toEqual(['from the host'])
    expect(store.shows(session.id)).toBe(false)
  })

  test('a released copy drops its read in flight', async () => {
    // WHY: when the live session takes the tab, a late cloud page must not land in it.
    const { store, session, holdNextRead, releaseRead } = harness()
    holdNextRead()
    const opening = store.open('tab-1')
    await settle()
    store.release(session.id)
    releaseRead()
    await opening
    expect(session.messages).toEqual([])
  })

  test('a closed tab drops its read in flight', async () => {
    const { store, session, holdNextRead, releaseRead, closeTab } = harness()
    holdNextRead()
    const opening = store.open('tab-1')
    await settle()
    closeTab()
    releaseRead()
    await opening
    expect(session.messages).toEqual([])
  })
})

describe('the state rules on the store', () => {
  test('session.headChanged makes the copy stale, and "Show newer turns" reads it again', async () => {
    // WHY: a newer turn is in the cloud; the copy must say so, then show it.
    const { store, session, setCloud, reads } = harness()
    await store.open('tab-1')
    setCloud({ ...CLOUD, head: 'b'.repeat(40), syncedTurn: 3 })
    expect(store.stateFor(session, 'laptop', false).view).toEqual({ kind: 'stale', reason: 'head-changed' })
    await store.reload('tab-1')
    expect(reads).toEqual([`${API}:newest`, `${API}:newest`])
    expect(store.stateFor(session, 'laptop', false).view).toEqual({ kind: 'ready', unavailableTurnCount: 0 })
  })

  test('a host that holds the session coming online makes the copy stale until a live turn runs', async () => {
    // WHY: the live session replaces the copy; a turn the person sent on that host continues it.
    const { store, session } = harness()
    await store.open('tab-1')
    // The host that ran the last turn is the run host now, and it is online.
    expect(store.stateFor(session, 'studio', false).view).toEqual({ kind: 'stale', reason: 'host-online' })
    session.messages.push({ id: 'live', role: 'user', content: 'next', timestamp: 40 } as Message)
    expect(store.stateFor(session, 'studio', false).view).toBeNull()
  })

  test('an offline run host with no cloud copy says why', () => {
    // WHY: an empty pane is not honest when the reason is known.
    const { store, session } = harness({ cloud: null })
    expect(store.stateFor(session, 'studio', true)).toEqual({ view: { kind: 'sync-off' }, shouldRead: false })
    expect(store.stateFor(session, 'studio', false)).toEqual({ view: null, shouldRead: false })
  })
})

describe('turn diffs', () => {
  test('a diff reads once, an empty patch is "no change", and a failure can be tried again', async () => {
    // WHY: the diff is read when the person opens it, not for every turn on screen.
    const { store, session, diffReads } = harness({ diff: { status: 'available', patch: '' } })
    await store.open('tab-1')
    await store.loadDiff(session.id, 1)
    await store.loadDiff(session.id, 1)
    expect(diffReads).toEqual([1])
    expect(store.diffFor(session.id, 1)).toEqual({ status: 'no-change' })

    const failing = harness({ diff: new Error('offline') })
    await failing.store.open('tab-1')
    await failing.store.loadDiff(failing.session.id, 1)
    expect(failing.store.diffFor(failing.session.id, 1)).toEqual({ status: 'error' })
    await failing.store.loadDiff(failing.session.id, 1)
    expect(failing.diffReads).toEqual([1, 1])
  })

  test('too-large and not-available are kept as the API answered', async () => {
    const large = harness({ diff: { status: 'too-large', filesChanged: 2, additions: 9, deletions: 1 } })
    await large.store.open('tab-1')
    await large.store.loadDiff(large.session.id, 1)
    expect(large.store.diffFor(large.session.id, 1)).toEqual({ status: 'too-large', filesChanged: 2, additions: 9, deletions: 1 })
  })
})
