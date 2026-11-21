import { describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostRpcError } from '@solus/client-core/rpc-error'
import { sessionCloudReadView } from '@solus/client-core/session-cloud-read'
import { sessionCloudReadText } from '@solus/client-core/session-cloud-read-text'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import type { ListMySessionsResponse } from '@solus/contracts/session-repositories'
import type { SolusApiRequest } from '@solus/contracts/solus-api/request'
import type { SessionRecord } from '@solus/contracts/types'
import { SolusApp } from '../../apps/mobile/src/app/solus-app'
import type { ConversationStore } from '../../apps/mobile/src/features/conversation/conversation-store'
import { cloudReadProgress, cloudReadView } from '../../apps/mobile/src/features/threads/lib/cloud-read-view'
import { cloudTurnDiffView } from '../../apps/mobile/src/features/threads/lib/cloud-turn-diff-view'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import { FakeApi, FakeTransport, flushPromises, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

const SESSION = 'session-1'
const CLOUD_HEAD = 'c'.repeat(40)
type CloudItem = ListMySessionsResponse['items'][number]

const cloudItem = (facts: Partial<CloudItem> = {}): CloudItem => ({
  sessionId: SESSION, title: 'Fix the login', provider: 'claude-code', model: 'opus', repositoryKey: 'github.com/acme/app', branch: 'main',
  lastActivityAt: 20, head: CLOUD_HEAD, syncedTurn: 3, lastRunHostId: 'acct-laptop', runningHostId: null, ...facts,
})

const userRow = (id: string, text: string, timestamp = 1) => ({ role: 'user', content: text, messageId: id, timestamp })
const replyRow = (id: string, text: string, timestamp = 2) => ({ role: 'assistant', content: text, messageId: id, timestamp })

type MirrorPage = Pick<SessionHistoryPage, 'messages' | 'turnDiffs'>

/** The Solus API's pages of a mirrored session, oldest first; a read with no cursor answers the last one. */
function mirrorPages(pages: MirrorPage[]): (request: { before?: string }) => SessionHistoryPage {
  return ({ before }) => {
    const index = before === undefined ? pages.length - 1 : Number(before)
    return { ...pages[index]!, before: index > 0 ? String(index - 1) : null }
  }
}

/** A Solus API connection: the cloud's lists, its history pages, its turn diffs, and its events. */
function cloudApi(options: { items?: () => CloudItem[]; organization?: () => SessionRecord[]; page?: (request: { before?: string }) => SessionHistoryPage; diff?: (request: SolusApiRequest) => { status: number; body: string } }) {
  const events = new HostEventSubscriber()
  const accepted = new Set<() => void>()
  const pages: Array<{ sessionId: string; turnLimit: number; before?: string }> = []
  const diffs: SolusApiRequest[] = []
  const connection = {
    hostId: 'workspace:org-1',
    state: { readiness: 'ready' },
    events,
    api: {
      sessionCloudList: async () => options.items?.() ?? [],
      sessionRecordList: async () => ({ records: options.organization?.() ?? [], indexing: false }),
      loadSessionPage: async (request: { sessionId: string; turnLimit: number; before?: string }) => {
        pages.push(request)
        if (!options.page) throw new Error('no page')
        return options.page(request)
      },
      sessionTurnDiff: async (sessionId: string, turnIndex: number) => {
        const request = { method: 'GET' as const, path: `/sessions/${encodeURIComponent(sessionId)}/turns/${turnIndex}/diff` }
        diffs.push(request)
        const answer = options.diff?.(request) ?? { status: 404, body: '' }
        return answer.status === 404 ? { status: 'not-available' as const } : JSON.parse(answer.body)
      },
    },
    onAccepted: (listener: () => void) => { accepted.add(listener); return () => { accepted.delete(listener) } },
  }
  return {
    // SAFETY: the cloud owners read only these members of a connection.
    connection: connection as never,
    pages,
    diffs,
    transcriptChanged: (sessionId: string) => events.receive({ type: 'session.transcriptChanged', payload: { sessionId }, occurredAt: Date.now() }),
  }
}

/** A session as a host listed it earlier: no fact of a session repository. */
const HOST_RECORD = { sessionId: SESSION, provider: 'claude-code' as const, projectPath: '/a/app', cwd: '/a/app', model: null, reasoningEffort: null, title: 'Fix the login', customTitle: null }

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

describe('shared cloud read rule on mobile', () => {
  test('one view and one set of words covers no copy, error, ready, and stale', () => {
    // WHY: mobile and desktop must give the same reason and action for the same cloud read.
    const read = { status: 'ready' as const, error: null, hasNewerRows: false }
    const input = { source: 'cloud' as const, read, messageCount: 2, isTurnLive: false }
    const phone = (view: NonNullable<ReturnType<typeof sessionCloudReadView>>, liveServerId: string | null = null) => cloudReadView(view, 'Studio', liveServerId, () => 'Laptop')
    expect(phone(sessionCloudReadView({ ...input, read: null })!)).toMatchObject({ isLoading: true, placeholder: null })
    expect(phone(sessionCloudReadView({ ...input, read: { ...read, status: 'error', error: 'Boom' } })!)).toMatchObject({ placeholder: { title: 'Boom' }, action: { kind: 'retry' } })
    // A read that answers no rows: the words take the conversation's place, with no action to try again.
    const noCopy = sessionCloudReadView({ ...input, messageCount: 0 })!
    expect(phone(noCopy)).toMatchObject({ placeholder: { title: sessionCloudReadText(noCopy, 'Studio').message }, note: null, action: null })
    const ready = sessionCloudReadView(input)!
    expect(phone(ready).note).toContain(sessionCloudReadText(ready, 'Studio').message)
    const stale = sessionCloudReadView({ ...input, read: { ...read, hasNewerRows: true } })!
    expect(phone(stale)).toMatchObject({ placeholder: null, action: { kind: 'reload', label: 'Show newer turns' } })
    const hostStale = sessionCloudReadView({ ...input, liveServerId: 'inst-b' })!
    expect(phone(hostStale, 'inst-b').action).toMatchObject({ kind: 'open-live', hostId: 'inst-b', label: 'Open on Laptop' })
  })

  test('with no Solus API connection the phone says "no copy" and starts no read; a host conversation gets no note', () => {
    // WHY: a signed-in person with no organization has no Solus API to ask. A spinner would
    // never end and "Sign in" would be false. A conversation that a host shows must get no
    // cloud note at all: a made-up read there said "<host> has this session now".
    const idle = { status: { kind: 'idle' as const }, hasNewerRows: false }
    const noConnection = cloudReadProgress({ ...idle, source: 'cloud', hasConnection: false })
    expect(sessionCloudReadView({ source: 'cloud', read: noConnection, messageCount: 0, isTurnLive: false })).toEqual({ kind: 'not-in-cloud' })
    // With a connection, the read is not started yet: the copy loads.
    expect(sessionCloudReadView({ source: 'cloud', read: cloudReadProgress({ ...idle, source: 'cloud', hasConnection: true }), messageCount: 0, isTurnLive: false })).toEqual({ kind: 'loading' })
    const onHost = cloudReadProgress({ ...idle, source: null, hasConnection: false })
    expect(sessionCloudReadView({ source: null, read: onHost, messageCount: 4, isTurnLive: false })).toBeNull()
    // A read that this phone made passes its news of newer rows.
    expect(cloudReadProgress({ status: { kind: 'ready' }, source: 'cloud', hasConnection: true, hasNewerRows: true })).toEqual({ status: 'ready', error: null, hasNewerRows: true })
    expect(cloudReadProgress({ status: { kind: 'error', message: 'Boom' }, source: 'cloud', hasConnection: true, hasNewerRows: false })).toEqual({ status: 'error', error: 'Boom', hasNewerRows: false })
  })

  test('the mobile diff view preserves large and absent diff states', () => {
    // WHY: the native diff route must keep the reason when there is no patch to draw.
    expect(cloudTurnDiffView({ kind: 'loaded', diff: { status: 'too-large', filesChanged: 12, additions: 900, deletions: 40 } })).toMatchObject({ kind: 'message', canRetry: false })
    expect(cloudTurnDiffView({ kind: 'loaded', diff: { status: 'not-available' } })).toMatchObject({ kind: 'message', canRetry: false })
  })
})

describe('mobile read-only cloud read', () => {
  test('with the host offline a personal session shows the rows of the mirror, with no fact of a session repository', async () => {
    // WHY: the mirror is the one store for a reader. The phone asks it and takes its answer;
    // it must not wait for a repository head, which a session can lack while its rows are
    // in the mirror. A page holds many turns, and older pages come from the mirror too.
    const cloud = cloudApi({
      page: mirrorPages([
        { messages: [userRow('u1', 'First prompt', 10), replyRow('a1', 'First reply', 11)] },
        { messages: [userRow('u2', 'Second prompt', 20), replyRow('a2', 'Second reply', 21), userRow('u3', 'Third prompt', 30), replyRow('a3', 'Third reply', 31)] },
      ]),
    })
    const { app } = await phoneWithOfflineHost(studio({ online: false, hasCopy: true }), cloud)
    // The cloud lists no session repository of it.
    expect(app.cloudSessions.headFor(SESSION)).toBeNull()
    const store = app.conversation('inst-a', { record: HOST_RECORD })!
    await untilPhase(store, 'error')

    await store.controller.readCloudHistory()
    expect(texts(store)).toEqual(['Second prompt', 'Second reply', 'Third prompt', 'Third reply'])
    expect(cloud.pages).toEqual([{ sessionId: SESSION, provider: 'claude-code', turnLimit: 10, before: undefined, deferArtifactHtml: true }])
    expect(store.metaSnapshotOf()).toMatchObject({ cloudRead: { kind: 'ready' }, showsHostConversation: false, hasOlder: true })

    // Older turns read from the mirror, with no host.
    await store.controller.loadOlder()
    expect(texts(store)).toEqual(['First prompt', 'First reply', 'Second prompt', 'Second reply', 'Third prompt', 'Third reply'])
    expect(cloud.pages.at(-1)).toMatchObject({ before: '0' })
    expect(store.metaSnapshotOf().hasOlder).toBe(false)
  })

  test('"Changes" shows only under a turn whose diff the mirror holds, joined to its prompt by time', async () => {
    // WHY: a page names the turn diffs of its rows by the time each turn ended, not by a row.
    // A chip under the wrong turn opens the changes of another prompt; a chip under a turn
    // with no diff opens a dead end.
    const cloud = cloudApi({
      page: mirrorPages([
        // Turn 0 ended after its prompt (10) and before the next prompt (20).
        { messages: [userRow('u1', 'First prompt', 10), replyRow('a1', 'First reply', 11)], turnDiffs: [{ turnIndex: 0, endedAt: 15 }] },
        // Turn 1 has no diff in the mirror; turn 2 is the newest turn, with no prompt after it.
        { messages: [userRow('u2', 'Second prompt', 20), replyRow('a2', 'Second reply', 21), userRow('u3', 'Third prompt', 30), replyRow('a3', 'Third reply', 31)], turnDiffs: [{ turnIndex: 2, endedAt: 35 }] },
      ]),
    })
    const { app } = await phoneWithOfflineHost(studio({ online: false, hasCopy: true }), cloud)
    const store = app.conversation('inst-a', { record: HOST_RECORD })!
    await untilPhase(store, 'error')
    await store.controller.readCloudHistory()
    const turnOf = (promptId: string) => app.cloudHistory.turnOf(store.controller.model, promptId)
    expect(turnOf('u3')).toBe(2)
    expect(turnOf('u2')).toBeNull()
    // A reply row is not a prompt.
    expect(turnOf('a3')).toBeNull()

    await store.controller.loadOlder()
    expect(turnOf('u1')).toBe(0)
    expect(turnOf('u2')).toBeNull()
    expect(turnOf('u3')).toBe(2)
  })

  test('a session that the Solus API refuses is "no copy", not an error', async () => {
    // WHY: the Solus API refuses a session that is not in the mirror for this person (cloud
    // sync off, or not sent yet). "Try again" would never help; the words must say that
    // Solus Cloud has no copy.
    const cloud = cloudApi({ page: () => { throw new HostRpcError('This session is not shared with you', 'FORBIDDEN') } })
    const { app } = await phoneWithOfflineHost(studio({ online: false, hasCopy: true }), cloud)
    const store = app.conversation('inst-a', { record: HOST_RECORD })!
    await untilPhase(store, 'error')
    await store.controller.readCloudHistory()

    expect(store.metaSnapshotOf()).toMatchObject({ cloudRead: { kind: 'ready' }, hasOlder: false })
    expect(texts(store)).toEqual([])
    const view = sessionCloudReadView({ source: 'cloud', read: { status: 'ready', error: null, hasNewerRows: app.cloudHistory.hasNewerRows(SESSION) }, messageCount: store.orderSnapshot().length, isTurnLive: false })!
    expect(view).toEqual({ kind: 'not-in-cloud' })
    expect(cloudReadView(view, 'Studio', null, () => 'Studio')).toMatchObject({ placeholder: { title: 'Solus Cloud has no copy of this session.' }, action: null })
  })

  test('a published organization session with no session repository opens its copy on a host that is not its machine', async () => {
    // WHY: the phone had one read-only surface for personal sessions only. A published
    // organization session is in the mirror also when cloud sync is off on its machine, so
    // its row must open the same copy, and the phone must not ask a host to sync a session
    // repository that does not exist.
    const record = {
      ...HOST_RECORD, organizationId: 'org-1', publication: 'published', ownerKey: 'bob', runnerHostId: 'acct-vm', lastActivityAt: 30, parentSessionId: null,
    } as SessionRecord
    const cloud = cloudApi({
      organization: () => [record],
      page: mirrorPages([{ messages: [userRow('u1', 'Fix the build', 10), replyRow('a1', 'Done', 11)], turnDiffs: [{ turnIndex: 0, endedAt: 12 }] }]),
    })
    const { app, transport } = await phoneWithOfflineHost(studio({ online: true, hasCopy: false }), cloud)
    await transport.accept()
    await flushPromises()
    const shell = app.threads.thread('inst-a', SESSION)!
    expect(shell).toMatchObject({ cloudOnly: true, hostLabel: 'Solus Cloud' })
    expect(app.cloudSessions.headFor(SESSION)).toMatchObject({ head: null, syncedTurn: 0 })

    const store = app.conversation('inst-a', { record: shell.record, fromCloud: true })!
    await untilPhase(store, 'ready')
    await flushPromises()
    expect(store.metaSnapshotOf().hostHasNoCopy).toBe(true)
    await store.controller.readCloudHistory()
    expect(texts(store)).toEqual(['Fix the build', 'Done'])
    expect(app.cloudHistory.turnOf(store.controller.model, 'u1')).toBe(0)
    expect(transport.api.callsOf('sessionPrepare')).toEqual([])
  })

  test('rows that arrive in the mirror make the copy stale, and only a new read shows them', async () => {
    // WHY: the copy must not claim to be current when the mirror has newer rows, but a read
    // by itself resets the scroll of a person who reads (decision 2). The person asks for it.
    let pages: MirrorPage[] = [{ messages: [userRow('u1', 'First prompt', 10)] }]
    const cloud = cloudApi({ page: (request) => mirrorPages(pages)(request) })
    const { app } = await phoneWithOfflineHost(studio({ online: false, hasCopy: true }), cloud)
    const store = app.conversation('inst-a', { record: HOST_RECORD })!
    await untilPhase(store, 'error')
    // News of a session with no copy here says nothing.
    cloud.transcriptChanged(SESSION)
    expect(app.cloudHistory.hasNewerRows(SESSION)).toBe(false)

    await store.controller.readCloudHistory()
    cloud.transcriptChanged('another-session')
    expect(app.cloudHistory.hasNewerRows(SESSION)).toBe(false)

    pages = [{ messages: [userRow('u1', 'First prompt', 10), userRow('u2', 'Second prompt', 20)] }]
    let notified = 0
    app.cloudHistory.changes.subscribe(() => { notified += 1 })
    cloud.transcriptChanged(SESSION)
    expect(app.cloudHistory.hasNewerRows(SESSION)).toBe(true)
    expect(notified).toBe(1)
    await flushPromises()
    expect(cloud.pages).toHaveLength(1)
    expect(texts(store)).toEqual(['First prompt'])

    // "Show newer turns" is a new read.
    await store.controller.readCloudHistory()
    expect(texts(store)).toEqual(['First prompt', 'Second prompt'])
    expect(app.cloudHistory.hasNewerRows(SESSION)).toBe(false)

    // Another account: its news is not this one's.
    cloud.transcriptChanged(SESSION)
    app.cloudSessions.follow(null)
    expect(app.cloudHistory.hasNewerRows(SESSION)).toBe(false)
  })

  test('the host that comes back replaces the copy with its own history, with no reload', async () => {
    // WHY: requirement 4: when a host that holds the session comes online, the screen becomes
    // the live session; the copy never shows beside or after the host's history.
    const state = { online: false, hasCopy: true }
    const cloud = cloudApi({ items: () => [cloudItem()], page: mirrorPages([{ messages: [userRow('u1', 'First prompt')] }]) })
    const { app, transport } = await phoneWithOfflineHost(studio(state), cloud)
    const store = app.conversation('inst-a', { record: app.threads.thread('inst-a', SESSION)!.record, fromCloud: true })!
    await untilPhase(store, 'error')
    await store.controller.readCloudHistory()
    expect(texts(store)).toEqual(['First prompt'])

    state.online = true
    await transport.accept()
    await untilPhase(store, 'ready')
    await flushPromises()
    expect(texts(store)).toEqual(['Third prompt', 'Third reply, from the host'])
    expect(store.metaSnapshotOf()).toMatchObject({ cloudRead: { kind: 'idle' }, showsHostConversation: true })
    expect(app.cloudHistory.isCopy(store.controller.model)).toBe(false)
    // A late read changes nothing: the host's history stays.
    await store.controller.readCloudHistory()
    expect(texts(store)).toEqual(['Third prompt', 'Third reply, from the host'])
  })

  test('on a connected host with no copy, the copy shows and a prompt still goes to that host', async () => {
    // WHY: requirement 5: the composer stays usable; the existing flow continues the session
    // on the run host, which syncs from the cloud head the prompt carries.
    const state = { online: true, hasCopy: false }
    const cloud = cloudApi({ items: () => [cloudItem()], page: mirrorPages([{ messages: [userRow('u1', 'First prompt'), replyRow('a1', 'First reply')] }]) })
    const { app, transport } = await phoneWithOfflineHost(studio(state), cloud)
    await transport.accept()
    await flushPromises()
    const store = app.conversation('inst-a', { record: app.threads.thread('inst-a', SESSION)!.record, fromCloud: true })!
    await untilPhase(store, 'ready')
    expect(store.metaSnapshotOf().hostHasNoCopy).toBe(true)

    await store.controller.readCloudHistory()
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
