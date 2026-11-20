import { describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostRpcError } from '@solus/client-core/rpc-error'
import { sessionCloudState } from '@solus/client-core/session-cloud-state'
import type { ListMySessionsResponse } from '@solus/contracts/session-repositories'
import type { SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import { SolusApp } from '../../apps/mobile/src/app/solus-app'
import type { ConversationStore } from '../../apps/mobile/src/features/conversation/conversation-store'
import { CloudSessions } from '../../apps/mobile/src/features/threads/cloud-sessions'
import { SessionRunHosts } from '../../apps/mobile/src/features/threads/session-run-hosts'
import { ThreadDirectory } from '../../apps/mobile/src/features/threads/thread-directory'
import { runHostRowNote, runHostRowView, type RunHostRowInput } from '../../apps/mobile/src/features/threads/lib/run-host-row'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import { FakeApi, FakeTransport, flushPromises, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

const SESSION = 'session-1'
const CLOUD_HEAD = 'c'.repeat(40)
type CloudItem = ListMySessionsResponse['items'][number]

const cloudItem = (sessionId: string, facts: Partial<CloudItem> = {}): CloudItem => ({
  sessionId, title: `Cloud ${sessionId}`, provider: 'claude-code', model: 'opus', repositoryKey: 'github.com/acme/app', branch: 'main',
  lastActivityAt: 20, head: CLOUD_HEAD, syncedTurn: 4, lastRunHostId: 'acct-laptop', runningHostId: null, ...facts,
})

/** A Solus API connection that lists `items` and sends `session.headChanged`. */
function cloudApi(items: () => CloudItem[]) {
  const events = new HostEventSubscriber()
  const accepted = new Set<() => void>()
  let lists = 0
  const connection = {
    hostId: 'workspace:org-1',
    state: { readiness: 'ready' },
    events,
    api: { sessionCloudList: async () => { lists += 1; return items() } },
    onAccepted: (listener: () => void) => { accepted.add(listener); return () => { accepted.delete(listener) } },
  }
  return {
    // SAFETY: the cloud owner reads only these members of a connection.
    connection: connection as never,
    lists: () => lists,
    headChanged: (payload: { sessionId: string; head: string | null; syncedTurn: number; lastRunHostId: string | null; runningHostId: string | null }) =>
      events.receive({ type: 'session.headChanged', payload, occurredAt: Date.now() }),
    reconnect: () => { for (const listener of accepted) listener() },
  }
}

/** The phone's hosts by id, each with its account host id and whether it is connected. */
function cloudSessions(hosts: Record<string, { accountHostId: string; isReady: boolean }>) {
  return new CloudSessions({
    savedHostFor: (accountHostId) => Object.keys(hosts).find((hostId) => hosts[hostId]!.accountHostId === accountHostId) ?? null,
    isReady: (hostId) => hosts[hostId]?.isReady ?? false,
    hostIds: () => Object.keys(hosts),
  })
}

const listed = (sessionId: string, lastActivityAt: number) => ({ sessionId, provider: 'claude-code', projectPath: '/p', cwd: '/p', title: sessionId, lastActivityAt }) as unknown as SessionRecord

function hostConnection(records: SessionRecord[], syncedTurn: number) {
  return {
    state: { sessionGeneration: 0, readiness: 'ready' },
    api: {
      sessionRecordList: async (filter: SessionRecordListFilter) => ({ records: filter.scope === 'all' ? [] : records, indexing: false }),
      listProjects: async () => [],
      getSessionInfos: async (ids: string[]) => ids.map((sessionId) => ({ sessionId, head: `head-${syncedTurn}`, syncedTurn })),
    },
    facts: { value: () => undefined },
  }
}

/** A directory over hosts `a` (Studio) and `b` (Laptop), with the cloud. */
function directoryWithCloud(records: { a: SessionRecord[]; b: SessionRecord[] }, cloud: CloudSessions) {
  const connections = { a: hostConnection(records.a, 2), b: hostConnection(records.b, 3) }
  const hosts = [{ id: 'a', label: 'Studio' }, { id: 'b', label: 'Laptop' }]
  // SAFETY: the directory and the run host owner read only these members.
  const runHosts = new SessionRunHosts({ readyConnection: (hostId) => connections[hostId as 'a' | 'b'] as never, cloudHeadFor: cloud.headFor })
  const directory = new ThreadDirectory(
    { host: (id: string) => hosts.find((host) => host.id === id), hosts: () => hosts } as never,
    (hostId) => connections[hostId as 'a' | 'b'] as never,
    runHosts,
    cloud,
  )
  return { directory, runHosts }
}

const rows = (directory: ThreadDirectory) => directory.threads().map((thread) => `${thread.hostId}:${thread.record.sessionId}${thread.cloudOnly ? ':cloud' : ''}`)

describe('mobile cloud sessions in the thread list', () => {
  test('a session on two hosts and in the cloud shows once, from a host', async () => {
    // WHY: plan §9 and design §5.5: one session id, one row; a host's record always wins
    // over the cloud entry, because the host has the conversation.
    const cloud = cloudSessions({ a: { accountHostId: 'acct-studio', isReady: true }, b: { accountHostId: 'acct-laptop', isReady: true } })
    const api = cloudApi(() => [cloudItem(SESSION)])
    cloud.follow(api.connection)
    const { directory } = directoryWithCloud({ a: [listed(SESSION, 10)], b: [listed(SESSION, 9)] }, cloud)
    await directory.load('a')
    await directory.load('b')
    await flushPromises()
    expect(rows(directory)).toEqual([`b:${SESSION}`])
  })

  test('a session only the cloud lists shows as a cloud row and opens on the host that ran it', async () => {
    // WHY: design §5.5: a client with the host that ran the session offline still lists the
    // session; the row opens on that host, so the thread says it is offline and offers Run on.
    const cloud = cloudSessions({ a: { accountHostId: 'acct-studio', isReady: true }, b: { accountHostId: 'acct-laptop', isReady: false } })
    cloud.follow(cloudApi(() => [cloudItem(SESSION)]).connection)
    const { directory } = directoryWithCloud({ a: [listed('only-a', 5)], b: [] }, cloud)
    await directory.load('a')
    await flushPromises()
    expect(rows(directory)).toEqual([`b:${SESSION}:cloud`, 'a:only-a'])
    const shell = directory.thread('b', SESSION)!
    expect(shell).toMatchObject({ cloudOnly: true, hostLabel: 'Laptop' })
    // The four facts are plain properties of the thread record.
    expect(shell.record).toMatchObject({ head: CLOUD_HEAD, syncedTurn: 4, lastRunHostId: 'acct-laptop', runningHostId: null, title: 'Cloud session-1' })
  })

  test('a cloud row opens on a connected host when this phone keeps no host that ran it', async () => {
    // WHY: desktop decision 3: with no saved last run host, a connected host takes the
    // session from the cloud; the row says the session came from Solus Cloud.
    const cloud = cloudSessions({ a: { accountHostId: 'acct-studio', isReady: true } })
    cloud.follow(cloudApi(() => [cloudItem(SESSION, { lastRunHostId: 'acct-elsewhere' })]).connection)
    const { directory } = directoryWithCloud({ a: [], b: [] }, cloud)
    await directory.load('a')
    await flushPromises()
    expect(directory.thread('a', SESSION)).toMatchObject({ cloudOnly: true, hostLabel: 'Solus Cloud' })
  })

  test('no cloud row when the connected host that ran the session does not list it', async () => {
    // WHY: that host archived the session; the cloud keeps no list state for a personal
    // session (D2), so a cloud row would bring an archived session back.
    const cloud = cloudSessions({ a: { accountHostId: 'acct-studio', isReady: true } })
    cloud.follow(cloudApi(() => [cloudItem(SESSION, { lastRunHostId: 'acct-studio' })]).connection)
    const { directory } = directoryWithCloud({ a: [], b: [] }, cloud)
    await directory.load('a')
    await flushPromises()
    expect(rows(directory)).toEqual([])
  })

  test('sign-out removes the cloud rows; a reconnect lists again with no second row', async () => {
    // WHY: plan §13 reverse states: cloud state belongs to the account and leaves with it;
    // a reconnect reads the list again, so a fact missed while away is not stale.
    const cloud = cloudSessions({ a: { accountHostId: 'acct-studio', isReady: true } })
    let items = [cloudItem(SESSION, { lastRunHostId: null })]
    const api = cloudApi(() => items)
    cloud.follow(api.connection)
    const { directory } = directoryWithCloud({ a: [], b: [] }, cloud)
    await directory.load('a')
    await flushPromises()
    expect(rows(directory)).toEqual([`a:${SESSION}:cloud`])

    items = [cloudItem(SESSION, { lastRunHostId: null, syncedTurn: 5, head: 'd'.repeat(40) })]
    api.reconnect()
    await flushPromises()
    expect(api.lists()).toBe(2)
    expect(rows(directory)).toEqual([`a:${SESSION}:cloud`])
    expect(cloud.headFor(SESSION)?.syncedTurn).toBe(5)

    cloud.follow(null)
    expect(rows(directory)).toEqual([])
    expect(cloud.headFor(SESSION)).toBeNull()
    expect(cloud.connectionId).toBeNull()
  })
})

describe('mobile session.headChanged', () => {
  test('writes the four facts into the record in place', async () => {
    // WHY: performance rule (plan §12): a head report changes plain properties of one
    // record; the row object stays, and no list or transcript is built again.
    const cloud = cloudSessions({ a: { accountHostId: 'acct-studio', isReady: true } })
    const api = cloudApi(() => [cloudItem(SESSION, { lastRunHostId: null })])
    cloud.follow(api.connection)
    await flushPromises()
    const record = cloud.recordFor(SESSION)!
    let notified = 0
    cloud.changes.subscribe(() => { notified += 1 })
    api.headChanged({ sessionId: SESSION, head: 'e'.repeat(40), syncedTurn: 6, lastRunHostId: 'acct-studio', runningHostId: 'acct-studio' })
    expect(cloud.recordFor(SESSION)).toBe(record)
    expect(record).toMatchObject({ head: 'e'.repeat(40), syncedTurn: 6, lastRunHostId: 'acct-studio', runningHostId: 'acct-studio' })
    expect(notified).toBe(1)
    // The same facts again change nothing.
    api.headChanged({ sessionId: SESSION, head: 'e'.repeat(40), syncedTurn: 6, lastRunHostId: 'acct-studio', runningHostId: 'acct-studio' })
    expect(notified).toBe(1)
    expect(api.lists()).toBe(1)
  })

  test('a session with no card yet is listed again', async () => {
    // WHY: the event has no card (title, provider), so a new session needs the list read.
    const cloud = cloudSessions({})
    let items: CloudItem[] = []
    const api = cloudApi(() => items)
    cloud.follow(api.connection)
    await flushPromises()
    items = [cloudItem('new-session')]
    api.headChanged({ sessionId: 'new-session', head: CLOUD_HEAD, syncedTurn: 1, lastRunHostId: 'acct-laptop', runningHostId: null })
    await flushPromises()
    expect(api.lists()).toBe(2)
    expect(cloud.recordFor('new-session')?.title).toBe('Cloud new-session')
  })
})

describe('mobile source rule with the cloud', () => {
  test('a prompt carries the cloud head and the host that pushed it when the cloud is newest', () => {
    // WHY: design §5.4 item 5: the run host fetches the newest head from the cloud first;
    // the host that ran the last turn is named as the cloud names it.
    const cloud = cloudSessions({ a: { accountHostId: 'acct-studio', isReady: true }, b: { accountHostId: 'acct-laptop', isReady: false } })
    cloud.follow(cloudApi(() => []).connection)
    const runHosts = new SessionRunHosts({ readyConnection: () => null, cloudHeadFor: (sessionId) => sessionId === SESSION ? { ...cloudItem(SESSION), lastRunServerId: 'b' } : null })
    runHosts.noteMeta('a', { sessionId: SESSION, head: 'h2', syncedTurn: 2 })
    expect(runHosts.promptFields(SESSION, 'a')).toEqual({ knownHead: CLOUD_HEAD, sourceHostId: 'acct-laptop' })
    expect(runHosts.newestHostOf(SESSION, 'a')).toBe('b')
    // The host that ran the last turn, or a host with the cloud head, starts at once.
    expect(runHosts.promptFields(SESSION, 'b')).toEqual({})
    runHosts.noteMeta('a', { sessionId: SESSION, head: CLOUD_HEAD, syncedTurn: 4 })
    expect(runHosts.promptFields(SESSION, 'a')).toEqual({})
  })

  test('a host ahead of the cloud stays the source, and a turn that ends counts past the cloud', () => {
    // WHY: a tie or a newer host copy is read directly from the host; after a turn on a
    // host, that host has one more turn than the cloud, so no prompt sends it back.
    const runHosts = new SessionRunHosts({ readyConnection: () => null, cloudHeadFor: () => ({ ...cloudItem(SESSION), lastRunServerId: 'b' }) })
    runHosts.noteMeta('b', { sessionId: SESSION, head: 'h4', syncedTurn: 4 })
    expect(runHosts.promptFields(SESSION, 'a')).toEqual({ knownHead: 'h4', sourceHostId: 'b' })
    runHosts.noteTurnSettled('a', SESSION)
    expect(runHosts.turnsFor(SESSION).find((turn) => turn.serverId === 'a')?.syncedTurn).toBe(5)
    expect(runHosts.promptFields(SESSION, 'a')).toEqual({})
  })
})

describe('mobile cloud states', () => {
  const idle: RunHostRowInput = {
    runHostId: 'a', isStarted: true, mayDrive: true, status: 'idle', backgroundWorkRunning: false,
    hasUnsentPrompts: false, hasAttachments: false, newestHostId: 'a',
    hosts: [
      { hostId: 'a', label: 'Studio', isReady: true, isAway: false },
      { hostId: 'b', label: 'Laptop', isReady: true, isAway: false },
    ],
  }
  const cloud = { ...cloudItem(SESSION), lastRunServerId: 'b' }

  test('"Not synced yet" when a host has a turn the cloud does not', () => {
    // WHY: plan §10: the person sees that the newest turn has not reached the cloud yet;
    // with no cloud copy at all (sync off, or before the first push) nothing is said.
    const state = sessionCloudState({ runServerId: 'a', turns: [{ serverId: 'a', head: 'h5', syncedTurn: 5 }], cloud, runningServerId: null })
    const view = runHostRowView({ ...idle, cloudState: state })
    expect(runHostRowNote(view)).toBe('Not synced yet')
    expect(view.isLocked).toBe(false)
    expect(sessionCloudState({ runServerId: 'a', turns: [{ serverId: 'a', head: 'h5', syncedTurn: 5 }], cloud: null, runningServerId: null })).toBeNull()
    // The note shows with no other host to choose too.
    expect(runHostRowNote(runHostRowView({ ...idle, hosts: [idle.hosts[0]!], cloudState: state }))).toBe('Not synced yet')
  })

  test('"Running on <host>" locks the host control and names where the prompt goes', () => {
    // WHY: plan §4 decision 5: one turn at a time; while another host runs a turn, the host
    // stays, and a prompt goes to the host that runs it.
    const state = sessionCloudState({ runServerId: 'a', turns: [], cloud, runningServerId: 'b' })
    const view = runHostRowView({ ...idle, cloudState: state })
    expect(runHostRowNote(view)).toBe('Running on Laptop')
    expect(view).toMatchObject({ isLocked: true, runningHostId: 'b' })
    // It wins over "<host> is offline".
    const away = runHostRowView({ ...idle, newestHostId: 'c', hosts: [...idle.hosts, { hostId: 'c', label: 'Box', isReady: false, isAway: true }], cloudState: state })
    expect(runHostRowNote(away)).toBe('Running on Laptop')
  })

  test('a refused push says where the session continued, from the host facts or a refused prompt', () => {
    // WHY: design answer 3.4: the turns on this host are not in the session; the person
    // must see why the host refuses prompts, and the one action that continues.
    const fromFacts = sessionCloudState({ runServerId: 'a', turns: [{ serverId: 'a', head: 'h3', syncedTurn: 3, pushRefused: true }], cloud, runningServerId: null })
    const view = runHostRowView({ ...idle, cloudState: fromFacts })
    expect(view.pushRefusedText).toBe('This session continued on Laptop. The turns on this machine are not in it.')
    expect(runHostRowNote(view)).toBeNull()
    const fromPrompt = sessionCloudState({ runServerId: 'a', turns: [], cloud, runningServerId: null, wasPromptRefused: true })
    expect(fromPrompt?.kind).toBe('push-refused')
  })
})

function untilReady(store: ConversationStore): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (store.controller.phase.kind !== 'ready') return
      stop()
      resolve()
    }
    const stop = store.meta.subscribe(check)
    check()
  })
}

/** The phone with one connected host, Studio, and the cloud. */
async function phoneWithCloud(api: FakeApi, items: CloudItem[]) {
  const transports = new Map<string, FakeTransport>()
  let nextId = 0
  const app = new SolusApp({
    storage: memoryKeyValueStore(),
    secrets: memorySecretStore(),
    fetch: healthFetch({ 'http://a:1': 'inst-a' }),
    createTransport: (options) => {
      const transport = new FakeTransport(options, api)
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
  await transports.get('inst-a')!.accept()
  const cloud = cloudApi(() => items)
  app.cloudSessions.follow(cloud.connection)
  await flushPromises()
  return { app, transport: transports.get('inst-a')! }
}

describe('mobile cloud-only conversation', () => {
  test('opens with no history until the host has a copy, and prepares from the cloud at once', async () => {
    // WHY: design §5.5: the host has no copy, so there is no history to read; it syncs from
    // the cloud in the background and the conversation shows when the sync ends.
    let hasCopy = false
    const api = new FakeApi()
      .on('describeSession', () => ({ lineage: null, meta: hasCopy ? { sessionId: SESSION, provider: 'claude-code', head: CLOUD_HEAD, syncedTurn: 4, cwd: '/a/app', projectPath: '/a/app' } : null }))
      .on('loadSessionPage', () => ({ messages: [{ role: 'user', content: 'hello', messageId: 'm1', timestamp: 1 }], before: null }))
      .on('watchSession', () => ({ runtime: null }))
      .on('unwatchSession', () => undefined)
      .on('setSessionReadState', () => Date.now())
      .on('sessionPrepare', () => ({ state: 'started' }))
    const { app, transport } = await phoneWithCloud(api, [cloudItem(SESSION)])
    const shell = app.threads.thread('inst-a', SESSION)!
    expect(shell.cloudOnly).toBe(true)

    const store = app.conversation('inst-a', { record: shell.record, fromCloud: true })!
    await untilReady(store)
    await flushPromises()
    expect(api.callsOf('loadSessionPage')).toEqual([])
    expect(api.callsOf('sessionPrepare')).toEqual([[{ sessionId: SESSION, knownHead: CLOUD_HEAD, sourceHostId: 'acct-laptop' }]])

    hasCopy = true
    transport.emitSession(SESSION, { type: 'status_card', card: { id: `session-sync-${SESSION}`, title: 'Session ready', status: 'done', steps: [] } })
    await untilReady(store)
    await flushPromises()
    expect(api.callsOf('loadSessionPage')).toHaveLength(1)
    expect(store.controller.run.workingDirectory).toBe('/a/app')
  })

  test('a prompt refused with SESSION_DIVERGED offers the newer copy, which syncs to the cloud head', async () => {
    // WHY: design answer 3.4: the host refuses prompts after a refused push; "Use the newer
    // copy" is a sessionPrepare with the cloud head, and the conversation is read again.
    const api = new FakeApi()
      .on('describeSession', () => ({ lineage: null, meta: { sessionId: SESSION, provider: 'claude-code', head: 'h3', syncedTurn: 3, cwd: '/a/app', projectPath: '/a/app' } }))
      .on('loadSessionPage', () => ({ messages: [{ role: 'user', content: 'hello', messageId: 'm1', timestamp: 1 }], before: null }))
      .on('watchSession', () => ({ runtime: null }))
      .on('unwatchSession', () => undefined)
      .on('setSessionReadState', () => Date.now())
      .on('prompt', () => { throw new HostRpcError('This host has a different session history.', 'SESSION_DIVERGED') })
      .on('sessionPrepare', () => ({ state: 'current', head: CLOUD_HEAD }))
    const { app } = await phoneWithCloud(api, [cloudItem(SESSION)])
    const record = { sessionId: SESSION, provider: 'claude-code' as const, projectPath: '/a/app', cwd: '/a/app', model: null, reasoningEffort: null, title: 'Fix it', customTitle: null }
    const store = app.conversation('inst-a', { record })!
    await untilReady(store)
    await store.controller.send('keep going').catch(() => undefined)
    await flushPromises()
    expect(store.metaSnapshotOf().isSessionDiverged).toBe(true)

    await store.controller.takeNewerCopy()
    await untilReady(store)
    await flushPromises()
    expect(api.callsOf('sessionPrepare').at(-1)).toEqual([{ sessionId: SESSION, knownHead: CLOUD_HEAD, sourceHostId: 'acct-laptop' }])
    expect(api.callsOf('loadSessionPage')).toHaveLength(2)
    expect(store.metaSnapshotOf().isSessionDiverged).toBe(false)
  })
})
