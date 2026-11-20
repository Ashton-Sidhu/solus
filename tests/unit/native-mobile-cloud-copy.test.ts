import { describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import {
  readSessionTurnDiff,
  sessionCloudCopyState,
  shouldReadSessionCloudCopy,
  type SessionCloudCopyInput,
} from '@solus/client-core/session-cloud-copy'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import type { ListMySessionsResponse } from '@solus/contracts/session-repositories'
import type { SolusApiRequest } from '@solus/contracts/solus-api/request'
import { SolusApp } from '../../apps/mobile/src/app/solus-app'
import type { ConversationStore } from '../../apps/mobile/src/features/conversation/conversation-store'
import { CloudSessions } from '../../apps/mobile/src/features/threads/cloud-sessions'
import { cloudCopyView } from '../../apps/mobile/src/features/threads/lib/cloud-copy-view'
import { cloudTurnDiffView } from '../../apps/mobile/src/features/threads/lib/cloud-turn-diff-view'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import { FakeApi, FakeTransport, flushPromises, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

const SESSION = 'session-1'
const CLOUD_HEAD = 'c'.repeat(40)
const NEWER_HEAD = 'd'.repeat(40)
type CloudItem = ListMySessionsResponse['items'][number]

const cloudItem = (facts: Partial<CloudItem> = {}): CloudItem => ({
  sessionId: SESSION, title: 'Fix the login', provider: 'claude-code', model: 'opus', repositoryKey: 'github.com/acme/app', branch: 'main',
  lastActivityAt: 20, head: CLOUD_HEAD, syncedTurn: 3, lastRunHostId: 'acct-laptop', runningHostId: null, ...facts,
})

const userRow = (id: string, text: string) => ({ role: 'user', content: text, messageId: id, timestamp: 1 })
const replyRow = (id: string, text: string) => ({ role: 'assistant', content: text, messageId: id, timestamp: 2 })

/** The Solus API's archived turns, one page for each turn, newest first, as Phase 5A answers them. */
function archivedTurns(turns: Array<SessionHistoryPage['messages'] | null>): (request: { before?: string }) => SessionHistoryPage {
  return ({ before }) => {
    const index = before === undefined ? turns.length - 1 : Number(JSON.parse(before).before)
    const next = index > 0 ? JSON.stringify({ before: String(index - 1), at: 0 }) : null
    const rows = turns[index]
    return rows ? { messages: rows, before: next, availability: 'available' } : { messages: [], before: next, availability: 'not-available', unavailableTurns: [index] }
  }
}

/** A Solus API connection: the cloud's list, its history pages, its turn diffs, and `session.headChanged`. */
function cloudApi(options: { items: () => CloudItem[]; page?: (request: { before?: string }) => SessionHistoryPage; diff?: (request: SolusApiRequest) => { status: number; body: string } }) {
  const events = new HostEventSubscriber()
  const accepted = new Set<() => void>()
  const pages: Array<{ sessionId: string; turnLimit: number; before?: string }> = []
  const diffs: SolusApiRequest[] = []
  const connection = {
    hostId: 'workspace:org-1',
    state: { readiness: 'ready' },
    events,
    api: {
      sessionCloudList: async () => options.items(),
      loadSessionPage: async (request: { sessionId: string; turnLimit: number; before?: string }) => {
        pages.push(request)
        if (!options.page) throw new Error('no page')
        return options.page(request)
      },
      solusApiRequest: async (request: SolusApiRequest) => {
        diffs.push(request)
        const answer = options.diff?.(request) ?? { status: 404, body: '' }
        return { ...answer, etag: null, retryAfter: null }
      },
    },
    onAccepted: (listener: () => void) => { accepted.add(listener); return () => { accepted.delete(listener) } },
  }
  return {
    // SAFETY: the cloud owners read only these members of a connection.
    connection: connection as never,
    pages,
    diffs,
    headChanged: (payload: { sessionId: string; head: string | null; syncedTurn: number; lastRunHostId: string | null; runningHostId: string | null }) =>
      events.receive({ type: 'session.headChanged', payload, occurredAt: Date.now() }),
  }
}

/** The phone with one saved host, Studio, signed in to the cloud; the host is offline until `accept`. */
async function phoneWithOfflineHost(host: FakeApi, cloud: ReturnType<typeof cloudApi>) {
  const transports = new Map<string, FakeTransport>()
  let nextId = 0
  const app = new SolusApp({
    storage: memoryKeyValueStore(),
    secrets: memorySecretStore(),
    fetch: healthFetch({ 'http://a:1': 'inst-a' }),
    createTransport: (options) => {
      const transport = new FakeTransport(options, host)
      transports.set(options.serverId ?? '', transport)
      return transport
    },
    openBrowser: async () => {},
    deviceLabel: 'Solus for iPhone',
    uuid: () => `uuid-${++nextId}`,
  })
  await app.load()
  await app.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'Studio', url: 'http://a:1' }, 'ta')
  app.connections.connection('inst-a')
  app.cloudSessions.follow(cloud.connection)
  await flushPromises()
  return { app, transport: transports.get('inst-a')! }
}

/** Studio's API. `online` decides whether it answers; offline, every read fails as an unreachable host's does. */
function studio(state: { online: boolean; hasCopy: boolean }) {
  const reachable = <T>(answer: () => T) => () => {
    if (!state.online) throw new Error('The host inst-a is unreachable')
    return answer()
  }
  return new FakeApi()
    .on('describeSession', reachable(() => ({ lineage: null, meta: state.hasCopy ? { sessionId: SESSION, provider: 'claude-code', head: CLOUD_HEAD, syncedTurn: 3, cwd: '/a/app', projectPath: '/a/app' } : null })))
    .on('loadSessionPage', reachable(() => ({ messages: [userRow('host-u3', 'Third prompt'), replyRow('host-a3', 'Third reply, from the host')], before: null })))
    .on('watchSession', reachable(() => ({ runtime: null })))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => Date.now())
    .on('sessionPrepare', reachable(() => ({ state: 'started' })))
    .on('prompt', reachable(() => ({ disposition: 'started' })))
}

function untilPhase(store: ConversationStore, kind: 'ready' | 'error'): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (store.controller.phase.kind !== kind) return
      stop()
      resolve()
    }
    const stop = store.meta.subscribe(check)
    check()
  })
}

const texts = (store: ConversationStore) => store.orderSnapshot().map((id) => {
  const item = store.item(id)
  return item?.kind === 'user' || item?.kind === 'assistant' ? item.text : item?.kind
})

const base: SessionCloudCopyInput = {
  hasStarted: true, showsHostConversation: false, isRunHostAway: true, hasLoadFailed: false, awaitsHostCopy: false,
  isSignedIn: true, cloudList: 'listed', cloud: { head: CLOUD_HEAD, syncedTurn: 3 }, isCloudSyncOn: null,
  read: { kind: 'idle' }, readHead: null, unavailableTurns: 0, liveServerId: null,
}

describe('cloud copy state rule', () => {
  test('applies only while no host that holds the session can show it', () => {
    // WHY: plan §10 "With no host online, the session opens read-only from the home": a host
    // that shows the conversation, or a run host that can still answer, wins over the copy.
    expect(sessionCloudCopyState({ ...base, showsHostConversation: true })).toBeNull()
    expect(sessionCloudCopyState({ ...base, isRunHostAway: false })).toBeNull()
    expect(sessionCloudCopyState({ ...base, hasStarted: false })).toBeNull()
    expect(sessionCloudCopyState({ ...base, isRunHostAway: false, hasLoadFailed: true })?.kind).toBe('loading')
    expect(sessionCloudCopyState({ ...base, isRunHostAway: false, awaitsHostCopy: true })?.kind).toBe('loading')
  })

  test('names why there is no copy: signed out, sync off, not in the cloud, or no turn yet', () => {
    // WHY: Phase 5B requirement 4: each state is honest, so a person never waits for a copy
    // that cannot come; "sync off" shows only when the host's setting says so.
    expect(sessionCloudCopyState({ ...base, isSignedIn: false })).toEqual({ kind: 'not-signed-in' })
    expect(sessionCloudCopyState({ ...base, cloud: null, cloudList: 'loading' })).toEqual({ kind: 'loading' })
    expect(sessionCloudCopyState({ ...base, cloud: null, isCloudSyncOn: false })).toEqual({ kind: 'sync-off' })
    expect(sessionCloudCopyState({ ...base, cloud: null })).toEqual({ kind: 'not-in-cloud' })
    expect(sessionCloudCopyState({ ...base, cloud: null, cloudList: 'none' })).toEqual({ kind: 'not-in-cloud' })
    expect(sessionCloudCopyState({ ...base, cloud: { head: null, syncedTurn: 0 } })).toEqual({ kind: 'empty' })
    expect(sessionCloudCopyState({ ...base, read: { kind: 'error', message: 'Boom' } })).toEqual({ kind: 'error', message: 'Boom' })
  })

  test('a copy that shows is stale when a host that holds the session connects or the cloud head moves', () => {
    // WHY: Phase 5B requirement 4: rows read at an older head, or while a live host is
    // connected, can be behind; the person sees that and the way to the newer state.
    const ready = { ...base, read: { kind: 'ready' as const }, readHead: CLOUD_HEAD, unavailableTurns: 1 }
    expect(sessionCloudCopyState(ready)).toEqual({ kind: 'ready', unavailableTurns: 1, stale: null })
    expect(sessionCloudCopyState({ ...ready, cloud: { head: NEWER_HEAD, syncedTurn: 4 } })).toMatchObject({ kind: 'ready', stale: { kind: 'head-changed' } })
    expect(sessionCloudCopyState({ ...ready, liveServerId: 'inst-b' })).toMatchObject({ stale: { kind: 'host-online', serverId: 'inst-b' } })
    // Signed out, the copy goes: it belongs to the account.
    expect(sessionCloudCopyState({ ...ready, isSignedIn: false })).toEqual({ kind: 'not-signed-in' })
  })

  test('a read starts once, only when the cloud has a head', () => {
    // WHY: one read for each open; an empty cloud or a read in flight starts nothing.
    expect(shouldReadSessionCloudCopy(base)).toBe(true)
    expect(shouldReadSessionCloudCopy({ ...base, read: { kind: 'loading' } })).toBe(false)
    expect(shouldReadSessionCloudCopy({ ...base, cloud: { head: null, syncedTurn: 0 } })).toBe(false)
    expect(shouldReadSessionCloudCopy({ ...base, cloud: null, cloudList: 'loading' })).toBe(false)
  })
})

describe('cloud copy words on the phone', () => {
  const labelOf = (hostId: string) => (hostId === 'inst-b' ? 'Laptop' : 'Studio')

  test('a copy that shows says it is read-only and has no tool output', () => {
    // WHY: D8: archived rows hold no tool result bodies; that is a plain state, not an error.
    const view = cloudCopyView({ kind: 'ready', unavailableTurns: 0, stale: null }, 'Studio', labelOf)
    expect(view).toEqual({ placeholder: null, isLoading: false, note: 'Read-only copy from Solus Cloud. Tool output is not included.', action: null })
    expect(cloudCopyView({ kind: 'ready', unavailableTurns: 2, stale: null }, 'Studio', labelOf).note).toBe('Read-only copy from Solus Cloud. Tool output is not included. 2 turns are not in Solus Cloud.')
  })

  test('a stale copy offers the live host or the newer turns', () => {
    // WHY: requirement 4: no contradictory state; the person reaches the live session in one action.
    expect(cloudCopyView({ kind: 'ready', unavailableTurns: 0, stale: { kind: 'host-online', serverId: 'inst-b' } }, 'Studio', labelOf))
      .toMatchObject({ note: 'Laptop is online. This copy can be behind.', action: { kind: 'open-live', hostId: 'inst-b', label: 'Open on Laptop' } })
    expect(cloudCopyView({ kind: 'ready', unavailableTurns: 0, stale: { kind: 'head-changed' } }, 'Studio', labelOf))
      .toMatchObject({ note: 'Newer turns are in Solus Cloud.', action: { kind: 'reload' } })
  })

  test('states with no rows take the conversation place, and an error offers a retry', () => {
    // WHY: requirement 4: the empty state (no turn commit yet) and each refusal have their own words.
    expect(cloudCopyView({ kind: 'empty' }, 'Studio', labelOf).placeholder?.title).toBe('No turns in Solus Cloud yet')
    expect(cloudCopyView({ kind: 'sync-off' }, 'Studio', labelOf).placeholder?.detail).toBe('Cloud sync is off on Studio. The conversation shows here when Studio is back.')
    expect(cloudCopyView({ kind: 'not-signed-in' }, 'Studio', labelOf).placeholder?.title).toBe('Studio is offline')
    expect(cloudCopyView({ kind: 'loading' }, 'Studio', labelOf)).toMatchObject({ isLoading: true, placeholder: null })
    expect(cloudCopyView({ kind: 'error', message: 'Timed out' }, 'Studio', labelOf)).toMatchObject({ placeholder: { detail: 'Timed out' }, action: { kind: 'retry' } })
  })

  test('a turn diff that is too large or not in the cloud says so with its counts', () => {
    // WHY: requirement 3: `too-large` and `not-available` are honest states, not errors or blank screens.
    expect(cloudTurnDiffView({ kind: 'loaded', diff: { status: 'too-large', filesChanged: 12, additions: 900, deletions: 40 } }))
      .toEqual({ kind: 'message', title: 'Too large to show here', detail: 'This turn changed 12 files, +900 −40. Open the session on a host to see the changes.', canRetry: false })
    expect(cloudTurnDiffView({ kind: 'loaded', diff: { status: 'not-available' } })).toMatchObject({ title: 'Not in Solus Cloud', canRetry: false })
    expect(cloudTurnDiffView({ kind: 'loaded', diff: { status: 'available', patch: '  ' } })).toMatchObject({ title: 'No changes' })
    expect(cloudTurnDiffView({ kind: 'loaded', diff: { status: 'available', patch: 'diff --git a/x b/x' } })).toEqual({ kind: 'patch', patch: 'diff --git a/x b/x' })
    expect(cloudTurnDiffView({ kind: 'error', message: 'Gone' })).toMatchObject({ canRetry: true })
  })
})

describe('readSessionTurnDiff', () => {
  test('names the session and the turn in the path, and an older API is "not available"', async () => {
    // WHY: Phase 5A contract: GET /v1/sessions/:sessionId/turns/:turnIndex/diff; the shared
    // request client fills only one path parameter, so the path must carry both here.
    const requests: SolusApiRequest[] = []
    const api = (status: number, body: string) => ({
      solusApiRequest: async (request: SolusApiRequest) => { requests.push(request); return { status, body, etag: null, retryAfter: null } },
    })
    expect(await readSessionTurnDiff(api(200, JSON.stringify({ status: 'available', patch: 'diff' })), 'a b', 2)).toEqual({ status: 'available', patch: 'diff' })
    expect(requests[0]).toEqual({ method: 'GET', path: '/sessions/a%20b/turns/2/diff' })
    expect(await readSessionTurnDiff(api(404, ''), SESSION, 0)).toEqual({ status: 'not-available' })
    const failure = JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Not yours.', requestId: 'req-1' } })
    await expect(readSessionTurnDiff(api(403, failure), SESSION, 0)).rejects.toThrow('Not yours.')
  })
})

describe('mobile read-only cloud copy', () => {
  test('with the host offline the thread shows the cloud copy, newest turn first, and pages older turns', async () => {
    // WHY: requirement 1 and 2: the usual thread renders the Solus API reader's rows, by page,
    // newest first; a turn with no rows in the cloud is counted, not shown as an empty turn.
    const cloud = cloudApi({
      items: () => [cloudItem()],
      page: archivedTurns([[userRow('u1', 'First prompt'), replyRow('a1', 'First reply')], null, [userRow('u3', 'Third prompt'), replyRow('a3', 'Third reply')]]),
    })
    const { app } = await phoneWithOfflineHost(studio({ online: false, hasCopy: true }), cloud)
    const shell = app.threads.thread('inst-a', SESSION)!
    expect(shell.cloudOnly).toBe(true)
    const store = app.conversation('inst-a', { record: shell.record, fromCloud: true })!
    await untilPhase(store, 'error')

    await store.controller.readCloudCopy()
    expect(texts(store)).toEqual(['Third prompt', 'Third reply'])
    expect(cloud.pages).toEqual([{ sessionId: SESSION, provider: 'claude-code', turnLimit: 1, before: undefined }])
    expect(store.metaSnapshotOf()).toMatchObject({ cloudRead: { kind: 'ready' }, showsHostConversation: false, hasOlder: true })
    expect(app.cloudHistory.turnOf(store.controller.model, 'u3')).toBe(2)

    // Older turns read from the cloud, with no host: turn 1 has no rows, so turn 0 follows.
    await store.controller.loadOlder()
    expect(texts(store)).toEqual(['First prompt', 'First reply', 'Third prompt', 'Third reply'])
    expect(app.cloudHistory.copyOf(store.controller.model)).toEqual({ head: CLOUD_HEAD, unavailableTurns: 1 })
    expect(app.cloudHistory.turnOf(store.controller.model, 'u1')).toBe(0)
    expect(store.metaSnapshotOf().hasOlder).toBe(false)
  })

  test('the host that comes back replaces the copy with its own history, with no reload', async () => {
    // WHY: requirement 4: when a host that holds the session comes online, the screen becomes
    // the live session; the copy never shows beside or after the host's history.
    const state = { online: false, hasCopy: true }
    const cloud = cloudApi({ items: () => [cloudItem()], page: archivedTurns([[userRow('u1', 'First prompt')]]) })
    const { app, transport } = await phoneWithOfflineHost(studio(state), cloud)
    const store = app.conversation('inst-a', { record: app.threads.thread('inst-a', SESSION)!.record, fromCloud: true })!
    await untilPhase(store, 'error')
    await store.controller.readCloudCopy()
    expect(texts(store)).toEqual(['First prompt'])

    state.online = true
    await transport.accept()
    await untilPhase(store, 'ready')
    await flushPromises()
    expect(texts(store)).toEqual(['Third prompt', 'Third reply, from the host'])
    expect(store.metaSnapshotOf()).toMatchObject({ cloudRead: { kind: 'idle' }, showsHostConversation: true })
    expect(app.cloudHistory.isCopy(store.controller.model)).toBe(false)
    // A late read changes nothing: the host's history stays.
    await store.controller.readCloudCopy()
    expect(texts(store)).toEqual(['Third prompt', 'Third reply, from the host'])
  })

  test('on a connected host with no copy, the copy shows and a prompt still goes to that host', async () => {
    // WHY: requirement 5: the composer stays usable; the existing flow continues the session
    // on the run host, which syncs from the cloud head the prompt carries.
    const state = { online: true, hasCopy: false }
    const cloud = cloudApi({ items: () => [cloudItem()], page: archivedTurns([[userRow('u1', 'First prompt'), replyRow('a1', 'First reply')]]) })
    const { app, transport } = await phoneWithOfflineHost(studio(state), cloud)
    await transport.accept()
    await flushPromises()
    const store = app.conversation('inst-a', { record: app.threads.thread('inst-a', SESSION)!.record, fromCloud: true })!
    await untilPhase(store, 'ready')
    expect(store.metaSnapshotOf().hostHasNoCopy).toBe(true)

    await store.controller.readCloudCopy()
    expect(texts(store)).toEqual(['First prompt', 'First reply'])
    await store.controller.send('Keep going')
    await flushPromises()
    const host = transport.api
    expect(host.callsOf('prompt').at(-1)?.[1]).toMatchObject({ prompt: 'Keep going', knownHead: CLOUD_HEAD, sourceHostId: 'acct-laptop' })
    expect(texts(store)).toEqual(['First prompt', 'First reply', 'Keep going'])

    // The sync ends: the host's own history replaces the copy.
    state.hasCopy = true
    transport.emitSession(SESSION, { type: 'status_card', card: { id: `session-sync-${SESSION}`, title: 'Session ready', status: 'done', steps: [] } })
    await untilPhase(store, 'ready')
    await flushPromises()
    expect(texts(store)).toEqual(['Third prompt', 'Third reply, from the host'])
    expect(store.metaSnapshotOf().showsHostConversation).toBe(true)
  })

  test('a turn diff is read once from the Solus API and kept', async () => {
    // WHY: requirement 3: the diff of a turn comes from sessionTurnDiff; a turn's patch never
    // changes, so opening it again sends no second request.
    const cloud = cloudApi({ items: () => [cloudItem()], diff: () => ({ status: 200, body: JSON.stringify({ status: 'too-large', filesChanged: 3, additions: 10, deletions: 2 }) }) })
    const { app } = await phoneWithOfflineHost(studio({ online: false, hasCopy: true }), cloud)
    expect(app.cloudHistory.diffOf(SESSION, 1)).toEqual({ kind: 'idle' })
    const loading = app.cloudHistory.loadDiff(SESSION, 1)
    expect(app.cloudHistory.diffOf(SESSION, 1)).toEqual({ kind: 'loading' })
    await loading
    await app.cloudHistory.loadDiff(SESSION, 1)
    expect(app.cloudHistory.diffOf(SESSION, 1)).toEqual({ kind: 'loaded', diff: { status: 'too-large', filesChanged: 3, additions: 10, deletions: 2 } })
    expect(cloud.diffs).toEqual([{ method: 'GET', path: `/sessions/${SESSION}/turns/1/diff` }])

    // Sign-out ends the connection: its diffs go with it.
    app.cloudSessions.follow(null)
    expect(app.cloudHistory.diffOf(SESSION, 1)).toEqual({ kind: 'idle' })
  })
})

describe('mobile cloud list state', () => {
  test('is loading until the first list read answers, and a failed read still answers', async () => {
    // WHY: requirement 4: "not in Solus Cloud" must not show before the cloud answered; an
    // older Solus API with no list route must not leave the thread loading for ever.
    const cloud = new CloudSessions({ savedHostFor: () => null, isReady: () => false, hostIds: () => [] })
    expect(cloud.listState).toBe('none')
    let fail = false
    let answer: (items: CloudItem[]) => void = () => undefined
    const connection = {
      hostId: 'workspace:org-1',
      state: { readiness: 'ready' },
      events: new HostEventSubscriber(),
      api: { sessionCloudList: () => (fail ? Promise.reject(new Error('no route')) : new Promise<CloudItem[]>((resolve) => { answer = resolve })) },
      onAccepted: () => () => undefined,
    }
    // SAFETY: the cloud owner reads only these members of a connection.
    cloud.follow(connection as never)
    await flushPromises()
    expect(cloud.listState).toBe('loading')
    answer([cloudItem()])
    await flushPromises()
    expect(cloud.listState).toBe('listed')

    fail = true
    cloud.follow(null)
    // SAFETY: as above.
    cloud.follow({ ...connection, hostId: 'workspace:org-2' } as never)
    await flushPromises()
    expect(cloud.listState).toBe('listed')
    expect(cloud.recordCount).toBe(0)
  })
})
