import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Message, Session } from '@solus/contracts/types'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import { SessionHostTurns, type SessionCloudHead } from '@solus/client-core/session-heads'
import { readSessionCloudPage } from '@solus/client-core/session-cloud-read'
import { HostRpcError } from '@solus/client-core/rpc-error'
import { singleHostServerConnections } from './helpers/server-connections-mock'

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: singleHostServerConnections() }))
mock.module('@solus/workspace-ui/contexts/workspace/session-list.store.svelte', () => ({ sessionListStore: {} }))
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({ serversStore: {} }))
mock.module('@solus/workspace-ui/contexts/app/host-settings.store.svelte', () => ({ hostSettingsStore: {} }))
mock.module('@solus/workspace-ui/contexts/workspace/session-transcript', () => ({ loadSessionTranscript: async () => ({ messages: [] }) }))
// Bun runs the store uncompiled: `$state` is the identity.
const runes = globalThis as unknown as { $state?: unknown }
const previousState = runes.$state
runes.$state = <T>(value: T) => value
afterAll(() => { runes.$state = previousState })
const { CloudTranscriptStore, copyApiServerFor } = await import('@solus/workspace-ui/contexts/workspace/cloud-transcript.store.svelte')
const { RUNNER_NOT_HERE_READ_ONLY_REASON } = await import('@solus/workspace-ui/contexts/workspace/machine-references')
type Deps = ConstructorParameters<typeof CloudTranscriptStore>[0]

// The cloud copy of a session that no host shows
// (docs/plans/portable-sessions-cloud.md, Phase 5B, "The mirror for readers"): the
// Solus API answers it from the transcript mirror, a page of turns at a time,
// newest first, into the tab's own messages.

const HEAD = 'a'.repeat(40)
const API = 'workspace:org-1'
const CLOUD: SessionCloudHead = { head: HEAD, syncedTurn: 4, lastRunHostId: 'account-studio', runningHostId: null, lastRunServerId: 'studio' }
/** The two oldest turns. The second changed no file, so the mirror has no diff of it. */
const OLDER_PAGE = {
  messages: [
    { role: 'user', content: 'first', timestamp: 10 }, { role: 'assistant', content: 'one', timestamp: 11 },
    { role: 'user', content: 'second', timestamp: 20 }, { role: 'assistant', content: 'two', timestamp: 21 },
  ],
  before: null,
  turnDiffs: [{ turnIndex: 0, endedAt: 12 }],
} satisfies SessionHistoryPage
/** The two newest turns, each with a diff. */
const NEWEST_PAGE = {
  messages: [
    { role: 'user', content: 'third', timestamp: 30 }, { role: 'assistant', content: 'three', timestamp: 31 },
    { role: 'user', content: 'fourth', timestamp: 40 }, { role: 'assistant', content: 'four', timestamp: 41 },
  ],
  before: 'cursor-older',
  turnDiffs: [{ turnIndex: 2, endedAt: 32 }, { turnIndex: 3, endedAt: 42 }],
} satisfies SessionHistoryPage

/** A page as the tab's messages: one message for each row, at the row's time. */
const asMessages = (page: SessionHistoryPage): Message[] => page.messages.map((row, index) => ({ id: `${row.content}-${index}`, role: row.role, content: row.content, timestamp: row.timestamp }) as Message)

function harness(opts: {
  pages?: Record<string, SessionHistoryPage | Error>; cloud?: SessionCloudHead | null; diff?: SessionTurnDiff | Error
  apiServerId?: string | null; isCloudSyncOn?: boolean
  /** False: the organization of the session keeps its sessions on their hosts. */
  savesSessionsToCloud?: boolean
  /** The Solus API's own page route, in place of `pages`: the read then goes through `readSessionCloudPage`. */
  loadSessionPage?: (request: SessionHistoryPageRequest) => Promise<SessionHistoryPage>
} = {}) {
  const session = {
    id: 'session-1', agentSessionId: 'thread-1', messages: [] as Message[], status: 'idle', loadingHistory: false, readOnlyReason: null,
    historyCursor: null, historyTruncated: false, run: { provider: 'codex', location: {} },
  } as unknown as Session
  let tabSession: Session | undefined = session
  const cloud = opts.cloud === undefined ? CLOUD : opts.cloud
  const pages: Record<string, SessionHistoryPage | Error> = opts.pages ?? { newest: NEWEST_PAGE, 'cursor-older': OLDER_PAGE }
  const reads: string[] = []
  let releaseRead: (() => void) | null = null
  let holdNextRead = false
  const diffReads: number[] = []
  /** The listeners of `session.transcriptChanged`, by `<connection> <session>`. */
  const watchers = new Map<string, () => void>()
  const deps: Deps = {
    sessionFor: () => tabSession,
    apiServerFor: () => (opts.apiServerId === undefined ? API : opts.apiServerId),
    cloudHeadFor: () => cloud,
    hostTurnsFor: () => SessionHostTurns.none,
    isCloudSyncOn: () => opts.isCloudSyncOn,
    savesSessionsToCloud: () => opts.savesSessionsToCloud ?? true,
    watchRows: (apiServerId, sessionId, onNewerRows) => {
      const key = `${apiServerId} ${sessionId}`
      watchers.set(key, onNewerRows)
      return () => { watchers.delete(key) }
    },
    readPage: async (apiServerId, request) => {
      reads.push(`${apiServerId}:${request.before ?? 'newest'}`)
      if (opts.loadSessionPage) return readSessionCloudPage({ loadSessionPage: opts.loadSessionPage }, request)
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
    store, session, reads, diffReads, watchers,
    /** The Solus API says the mirror got rows or a turn diff of the session. */
    transcriptChanged: () => watchers.get(`${API} ${session.id}`)?.(),
    closeTab: () => { tabSession = undefined },
    holdNextRead: () => { holdNextRead = true },
    releaseRead: () => releaseRead?.(),
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('opening the cloud copy', () => {
  test('reads the newest page of turns from the Solus API into the tab, with a cursor to the older turns', async () => {
    // WHY: the usual conversation draws the copy, so it must arrive as the tab's
    // own messages and paging state, read from the Solus API, not from a host. The
    // mirror answers many turns for each page: one request must show them all.
    const { store, session, reads } = harness()
    expect(store.stateFor(session, 'laptop', false)).toEqual({ view: { kind: 'loading' }, shouldRead: true })
    await store.open('tab-1')
    expect(reads).toEqual([`${API}:newest`])
    expect(session.messages.map((message) => message.content)).toEqual(['third', 'three', 'fourth', 'four'])
    expect(session.historyCursor).toBe('cursor-older')
    expect(session.historyTruncated).toBe(true)
    expect(store.stateFor(session, 'laptop', false)).toEqual({ view: { kind: 'ready' }, shouldRead: false })
  })

  test('each turn diff the page names is kept with its index and the time its turn ended', async () => {
    // WHY: a row carries no turn index. The conversation joins a diff to its turn by
    // time (`turnSnapshotFor`), so the store must keep the end time the mirror gave,
    // and the index that `sessionTurnDiff` is asked with.
    const { store, session } = harness()
    await store.open('tab-1')
    expect(store.turnsFor(session.id)).toEqual([{ index: 2, timestamp: 32 }, { index: 3, timestamp: 42 }])
  })

  test('older pages read through the reader and add their turn diffs, without reading the newest again', async () => {
    // WHY: history loads by page as the person scrolls up; each page is one request,
    // and a turn that changed no file has no diff to offer.
    const { store, session, reads } = harness()
    await store.open('tab-1')
    const reader = store.reader(session)
    expect(reader?.serverId).toBe(API)
    await reader?.read('cursor-older')
    await reader?.read('cursor-older')
    expect(reads).toEqual([`${API}:newest`, `${API}:cursor-older`, `${API}:cursor-older`])
    expect(store.turnsFor(session.id)).toEqual([{ index: 2, timestamp: 32 }, { index: 3, timestamp: 42 }, { index: 0, timestamp: 12 }])
  })

  test('a page with no rows says that Solus Cloud has no copy, and reads no more pages', async () => {
    // WHY: the mirror's answer decides whether a copy exists. An empty pane, a spinner,
    // or an error with "Try again" would each be wrong for a session that was never sent.
    const { store, session, reads } = harness({ pages: { newest: { messages: [], before: null } } })
    await store.open('tab-1')
    expect(reads).toEqual([`${API}:newest`])
    expect(store.stateFor(session, 'studio', true)).toEqual({ view: { kind: 'not-in-cloud' }, shouldRead: false })
  })

  test('with no rows, the words name the sync switch only when the away run host has it off', async () => {
    // WHY: "cloud sync was off" is a statement about one machine. It is true only when
    // this client read that setting, and only of the machine the tab is on.
    const { store, session } = harness({ pages: { newest: { messages: [], before: null } }, isCloudSyncOn: false })
    await store.open('tab-1')
    expect(store.stateFor(session, 'studio', true).view).toEqual({ kind: 'sync-off' })
    session.readOnlyReason = RUNNER_NOT_HERE_READ_ONLY_REASON
    expect(store.stateFor(session, 'laptop', false).view).toEqual({ kind: 'not-in-cloud' })
  })

  test('a failed read is an error state that a retry reads again', async () => {
    // WHY: an error must not look like an empty session, and "Try again" must work.
    const pages: Record<string, SessionHistoryPage | Error> = { newest: new Error('offline') }
    const { store, session, reads } = harness({ pages })
    await store.open('tab-1')
    expect(store.stateFor(session, 'laptop', false).view).toMatchObject({ kind: 'error' })
    pages.newest = NEWEST_PAGE
    await store.reload('tab-1')
    expect(reads).toEqual([`${API}:newest`, `${API}:newest`])
    expect(store.stateFor(session, 'laptop', false).view).toEqual({ kind: 'ready' })
  })
})

describe('an organization that does not save its sessions in Solus Cloud', () => {
  test('a session whose host is away says that Solus Cloud has no copy, and the Solus API is not asked', async () => {
    // WHY: the hosts of such an organization send no conversation to Solus Cloud.
    // The setting gives the answer, so a read is a request for nothing and its
    // spinner is a state that is not true.
    const { store, session, reads, watchers } = harness({ savesSessionsToCloud: false })
    expect(store.stateFor(session, 'studio', true)).toEqual({ view: { kind: 'sync-off' }, shouldRead: false })
    await store.open('tab-1')
    expect(reads).toEqual([])
    expect(watchers.size).toBe(0)
    expect(store.shows(session.id)).toBe(false)
    expect(store.stateFor(session, 'studio', true).view).toEqual({ kind: 'sync-off' })
  })

  test('the answer is the same with no Solus API connection: a sign-in gives no copy', () => {
    const { store, session } = harness({ savesSessionsToCloud: false, cloud: null, apiServerId: null })
    expect(store.stateFor(session, 'studio', true)).toEqual({ view: { kind: 'sync-off' }, shouldRead: false })
  })

  test('a host that holds the session shows its own conversation, with no state', () => {
    // WHY: the setting says where the copy is not. It says nothing of a machine that is on.
    const { store, session } = harness({ savesSessionsToCloud: false, cloud: null })
    expect(store.stateFor(session, 'studio', false)).toEqual({ view: null, shouldRead: false })
  })
})

describe('the source needs no fact of the session repository', () => {
  test('an away run host is read from the mirror when the client has no repository facts of the session', async () => {
    // WHY: the mirror is the one store for a reader. An organization session with
    // cloud sync off has rows there and no session repository; a client that waited
    // for repository facts said "no copy" for a session it could read.
    const { store, session, reads } = harness({ cloud: null })
    expect(store.stateFor(session, 'studio', true)).toEqual({ view: { kind: 'loading' }, shouldRead: true })
    await store.open('tab-1')
    expect(reads).toEqual([`${API}:newest`])
    expect(store.stateFor(session, 'studio', true).view).toEqual({ kind: 'ready' })
  })

  test('a client with no Solus API connection says to sign in, and reads nothing', async () => {
    // WHY: without a connection there is nothing to ask; a spinner would never end.
    const { store, session, reads } = harness({ cloud: null, apiServerId: null })
    expect(store.stateFor(session, 'studio', true)).toEqual({ view: { kind: 'not-signed-in' }, shouldRead: false })
    await store.open('tab-1')
    expect(reads).toEqual([])
    expect(store.shows(session.id)).toBe(false)
  })

  test('an organization session on a host that is not its machine reads the copy, though that host is online', async () => {
    // WHY: the tab is on the Run on host only because this client does not keep the
    // session's machine. That host holds no copy, so "online" must not mean "shows it".
    const { store, session } = harness({ cloud: null })
    expect(store.stateFor(session, 'laptop', false)).toEqual({ view: null, shouldRead: false })
    session.readOnlyReason = RUNNER_NOT_HERE_READ_ONLY_REASON
    expect(store.stateFor(session, 'laptop', false)).toEqual({ view: { kind: 'loading' }, shouldRead: true })
    await store.open('tab-1')
    expect(store.stateFor(session, 'laptop', false).view).toEqual({ kind: 'ready' })
  })

  test('the connection is the one that gave facts, else the record home, else a ready Solus API connection', () => {
    // WHY: `listMySessions` names only sessions with a session repository. A session
    // without one is still in the mirror of its organization's Solus API, and a
    // personal session is in its owner's scope on any Solus API connection.
    const ready = () => 'workspace:org-2'
    expect(copyApiServerFor('workspace:org-1', 'workspace:org-3', ready)).toBe('workspace:org-1')
    expect(copyApiServerFor(null, 'workspace:org-3', ready)).toBe('workspace:org-3')
    expect(copyApiServerFor(null, 'studio', ready)).toBe('workspace:org-2')
    expect(copyApiServerFor(null, null, ready)).toBe('workspace:org-2')
    expect(copyApiServerFor(null, 'studio', () => null)).toBeNull()
  })
})

describe('a personal session with no host online', () => {
  // The session ran on a machine that is off now. Its owner has cloud sync on, so its
  // rows are in the owner's scope of the mirror. This client has no fact of a session
  // repository for it: `listMySessions` did not answer, or the repository has no turn.
  const personal = { cloud: null, apiServerId: copyApiServerFor(null, 'studio', () => API) }

  test('the mirror is asked through a Solus API connection, and its rows and turn diffs show', async () => {
    // WHY: the mirror is the one store for a reader, for a personal session also. The
    // offline view must not depend on the session repository, which is only for a host
    // that continues the session.
    const asked: SessionHistoryPageRequest[] = []
    const { store, session, reads } = harness({ ...personal, loadSessionPage: async (request) => { asked.push(request); return NEWEST_PAGE } })
    expect(store.stateFor(session, 'studio', true)).toEqual({ view: { kind: 'loading' }, shouldRead: true })
    await store.open('tab-1')
    expect(reads).toEqual([`${API}:newest`])
    expect(asked).toEqual([{ sessionId: 'session-1', provider: 'codex', before: undefined, turnLimit: 10, deferArtifactHtml: true }])
    expect(session.messages.map((message) => message.content)).toEqual(['third', 'three', 'fourth', 'four'])
    expect(store.turnsFor(session.id)).toEqual([{ index: 2, timestamp: 32 }, { index: 3, timestamp: 42 }])
    expect(store.stateFor(session, 'studio', true).view).toEqual({ kind: 'ready' })
  })

  test('a read that the Solus API refuses says "no copy", not an error', async () => {
    // WHY: the API gives no role on a session that is not in the mirror for this person
    // (cloud sync off, or not sent yet). "Try again" would never help; the words that
    // name the machine and Run on do.
    const { store, session } = harness({ ...personal, loadSessionPage: async () => { throw new HostRpcError('This session is not shared with you', 'FORBIDDEN') } })
    await store.open('tab-1')
    expect(session.messages).toEqual([])
    expect(store.stateFor(session, 'studio', true)).toEqual({ view: { kind: 'not-in-cloud' }, shouldRead: false })
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
    // WHY: the rows of a session must not land in a tab that shows another one, or none.
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
  test('rows that arrive in the mirror make the copy stale, and "Show newer turns" reads it again', async () => {
    // WHY: session.transcriptChanged means rows that the copy does not show. The copy
    // must say so. It must not read by itself: a new read resets the reader's scroll.
    const { store, session, transcriptChanged, reads } = harness()
    await store.open('tab-1')
    transcriptChanged()
    expect(store.stateFor(session, 'studio', true).view).toEqual({ kind: 'stale', reason: 'newer-rows' })
    expect(reads).toEqual([`${API}:newest`])
    await store.reload('tab-1')
    expect(reads).toEqual([`${API}:newest`, `${API}:newest`])
    expect(store.stateFor(session, 'studio', true).view).toEqual({ kind: 'ready' })
  })

  test('rows that arrive while the page is read make the copy stale when the read ends', async () => {
    // WHY: the page in flight may not hold a row that the mirror got after the request left.
    const { store, session, transcriptChanged, holdNextRead, releaseRead } = harness()
    holdNextRead()
    const opening = store.open('tab-1')
    await settle()
    transcriptChanged()
    expect(store.stateFor(session, 'studio', true).view).toEqual({ kind: 'loading' })
    releaseRead()
    await opening
    expect(store.stateFor(session, 'studio', true).view).toEqual({ kind: 'stale', reason: 'newer-rows' })
  })

  test('a released copy stops its watch of the Solus API', async () => {
    // WHY: a tab that closed, or that a host took, must not keep a listener on the
    // connection for each session a person ever read.
    const { store, session, watchers } = harness()
    await store.open('tab-1')
    expect(watchers.size).toBe(1)
    await store.reload('tab-1')
    expect(watchers.size).toBe(1)
    store.release(session.id)
    expect(watchers.size).toBe(0)
  })

  test('a host that holds the session coming online makes the copy stale until a live turn runs', async () => {
    // WHY: the live session replaces the copy; a turn the person sent on that host continues it.
    const { store, session } = harness()
    await store.open('tab-1')
    // The host that ran the last turn is the run host now, and it is online.
    expect(store.stateFor(session, 'studio', false).view).toEqual({ kind: 'stale', reason: 'host-online' })
    session.messages.push({ id: 'live', role: 'user', content: 'next', timestamp: 50 } as Message)
    expect(store.stateFor(session, 'studio', false).view).toBeNull()
  })

  test('an online run host that no fact says is behind shows its own conversation', () => {
    // WHY: a session that never left its host must load from that host as before.
    const { store, session } = harness({ cloud: null })
    expect(store.stateFor(session, 'studio', false)).toEqual({ view: null, shouldRead: false })
  })
})

describe('turn diffs', () => {
  test('a diff reads once, an empty patch is "no change", and a failure can be tried again', async () => {
    // WHY: the diff is read when the person opens it, not for every turn on screen.
    const { store, session, diffReads } = harness({ diff: { status: 'available', patch: '' } })
    await store.open('tab-1')
    await store.loadDiff(session.id, 3)
    await store.loadDiff(session.id, 3)
    expect(diffReads).toEqual([3])
    expect(store.diffFor(session.id, 3)).toEqual({ status: 'no-change' })

    const failing = harness({ diff: new Error('offline') })
    await failing.store.open('tab-1')
    await failing.store.loadDiff(failing.session.id, 3)
    expect(failing.store.diffFor(failing.session.id, 3)).toEqual({ status: 'error' })
    await failing.store.loadDiff(failing.session.id, 3)
    expect(failing.diffReads).toEqual([3, 3])
  })

  test('too-large and not-available are kept as the API answered', async () => {
    // WHY: each has its own words; the store must not turn one into an error or an empty diff.
    const large = harness({ diff: { status: 'too-large', filesChanged: 2, additions: 9, deletions: 1 } })
    await large.store.open('tab-1')
    await large.store.loadDiff(large.session.id, 3)
    expect(large.store.diffFor(large.session.id, 3)).toEqual({ status: 'too-large', filesChanged: 2, additions: 9, deletions: 1 })
  })
})
