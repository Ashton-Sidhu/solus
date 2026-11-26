import { afterEach, describe, expect, test } from 'bun:test'
import { resumeHistoryPage } from '@solus/server/data/sessions/history-blocks'
import { PullRequestCache, memoryPullRequestCacheDatabase, type PullRequestCacheDatabase } from '@solus/client-core/pull-request-cache'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'
import type { SessionRecord } from '@solus/contracts/types'
import { SolusApp } from '../../apps/mobile/solus-core/app/solus-app'
import { ConversationController, type ConversationTarget } from '../../apps/mobile/solus-core/features/conversation/conversation-controller'
import { noteSessionPress, setOpenTimingSink, type SessionOpenTimingLine } from '../../apps/mobile/solus-core/features/conversation/lib/open-timing'
import { HistoryPrefetch, openingHistoryRequest } from '../../apps/mobile/solus-core/features/threads/history-prefetch'
import { MobileSessionCache } from '../../apps/mobile/solus-core/features/threads/session-cache'
import type { HostThreads } from '../../apps/mobile/solus-core/features/threads/thread-directory'
import { memoryKeyValueStore, memorySecretStore, type SecretStore } from '../../apps/mobile/solus-core/platform/ports'
import { createHostWorld, FakeApi, FakeTransport, flushPromises, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

const page = (messages: SessionHistoryPage['messages'], before: string | null = null): SessionHistoryPage => ({ messages, before })
const userRow = (content: string, messageId: string) => ({ role: 'user', content, messageId, timestamp: 1 })

function sessionRecord(sessionId: string, lastActivityAt = 1_000): SessionRecord {
  // SAFETY: the list and the prefetch read only these fields of a record.
  return { sessionId, provider: 'claude-code', projectPath: '/work/app', cwd: '/work/app', title: sessionId, lastActivityAt, size: 10 } as SessionRecord
}

function savedList(hostId: string, sessionIds: string[]): HostThreads {
  return {
    threads: sessionIds.map(sessionId => ({ key: `${hostId}\u0000${sessionId}`, hostId, hostLabel: 'A', record: sessionRecord(sessionId) })),
    projects: [], indexing: false,
  }
}

/** A keychain whose reads wait until `open` is called: `load` stays pending while it waits. */
function slowSecrets(secrets: SecretStore = memorySecretStore()): SecretStore & { open(): void } {
  const gate = Promise.withResolvers<void>()
  return { ...secrets, get: async (key) => { await gate.promise; return secrets.get(key) }, open: () => gate.resolve() }
}

function phone(storage: ReturnType<typeof memoryKeyValueStore>, database: PullRequestCacheDatabase, secrets: SecretStore = memorySecretStore()) {
  return new SolusApp({
    storage, secrets, pullRequestCache: database,
    fetch: healthFetch({ 'http://a:1': 'inst-a' }), uuid: () => crypto.randomUUID(),
    createTransport: options => new FakeTransport(options, new FakeApi()),
    openBrowser: async () => {}, deviceLabel: 'Test phone',
  })
}

describe('first-frame session list', () => {
  test('the saved list of the last start shows before load resolves and stays when the account keeps its scope', async () => {
    const storage = memoryKeyValueStore()
    const secrets = memorySecretStore()
    const database = memoryPullRequestCacheDatabase()
    const first = phone(storage, database, secrets)
    await first.load()
    await first.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
    await first.sessionCache.forHost('inst-a').saveDirectory(savedList('inst-a', ['s1', 's2']))
    first.dispose()

    const slow = slowSecrets(secrets)
    const next = phone(storage, database, slow)
    let loaded = false
    const loading = next.load().then(() => { loaded = true })
    try {
      const presumed = next.presumeLastSessionList()
      expect(presumed.map(host => host.id)).toEqual(['inst-a'])
      for (const host of presumed) await next.threads.restore(host.id, host)
      expect(loaded).toBe(false)
      expect(next.threads.threads().map(row => row.record.sessionId)).toEqual(['s1', 's2'])
      slow.open()
      await loading
      next.confirmLastSessionList()
      expect(next.threads.threads().map(row => row.record.sessionId)).toEqual(['s1', 's2'])
    } finally {
      slow.open()
      next.dispose()
    }
  })

  test('a different scope from load drops the rows of the last start and never writes them into the new scope', async () => {
    const storage = memoryKeyValueStore()
    const database = memoryPullRequestCacheDatabase()
    // The last start was signed in to another account.
    storage.setItem('solus.mobile.lastSessionList', JSON.stringify({ scope: 'another-account', hosts: [{ id: 'inst-a', installationId: 'inst-a' }] }))
    await new MobileSessionCache(new PullRequestCache(database), () => 'another-account').forHost('inst-a').saveDirectory(savedList('inst-a', ['theirs']))
    const slow = slowSecrets()
    const app = phone(storage, database, slow)
    const loading = app.load()
    try {
      for (const host of app.presumeLastSessionList()) await app.threads.restore(host.id, host)
      expect(app.threads.threads().map(row => row.record.sessionId)).toEqual(['theirs'])
      slow.open()
      await loading
      expect(app.threads.threads()).toEqual([])
      expect(await app.sessionCache.forHost('inst-a').directory()).toBeNull()
      // The next start presumes this account's scope.
      expect(JSON.parse(storage.getItem('solus.mobile.lastSessionList')!).scope).toBe(app.sessionCache.scope())
    } finally {
      slow.open()
      app.dispose()
    }
  })

  test('a host the registry does not list loses its rows once the host list answered', async () => {
    const storage = memoryKeyValueStore()
    const database = memoryPullRequestCacheDatabase()
    const scope = JSON.stringify([null, null])
    storage.setItem('solus.mobile.lastSessionList', JSON.stringify({ scope, hosts: [{ id: 'gone', installationId: 'gone' }] }))
    await new MobileSessionCache(new PullRequestCache(database), () => scope).forHost('gone').saveDirectory(savedList('gone', ['old']))
    const app = phone(storage, database)
    try {
      for (const host of app.presumeLastSessionList()) await app.threads.restore(host.id, host)
      expect(app.threads.threads()).toHaveLength(1)
      await app.load()
      expect(app.sessionCache.scope()).toBe(scope)
      app.confirmLastSessionList()
      expect(app.threads.threads()).toEqual([])
    } finally { app.dispose() }
  })

  test('after the key read of a launch, hasHistoryKey answers true or false', async () => {
    const database = memoryPullRequestCacheDatabase()
    await new MobileSessionCache(new PullRequestCache(database), () => 'account').forHost('inst-a').saveHistory('s1', page([userRow('saved', 'm1')]))
    const launch = new MobileSessionCache(new PullRequestCache(database), () => 'account').forHost('inst-a')
    expect(launch.hasHistoryKey('s1')).toBeUndefined()
    await launch.readKeys()
    expect(launch.hasHistoryKey('s1')).toBe(true)
    expect(launch.hasHistoryKey('s2')).toBe(false)
    expect(launch.historySavedAt('s1')).toBeNumber()
  })
})

async function readyHost(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection('inst-a')!
  await (world.transports[0] as FakeTransport).accept()
  return { world, connection }
}

function baseApi(): FakeApi {
  return new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('watchSession', () => ({ runtime: null }))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => Date.now())
}

/** Waits on timers and promises until `done` is true, for at most one second. */
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; !done() && tries < 200; tries++) await new Promise(resolve => setTimeout(resolve, 5))
}

const historyCalls = (api: FakeApi) => api.callsOf('loadSessionPage').map(([request]) => request as SessionHistoryPageRequest)

describe('history prefetch', () => {
  test('a list read saves the first page of every row, top down, in batches of eight, with the request a saved open sends', async () => {
    let reading = 0
    let most = 0
    const releases: Array<() => void> = []
    const api = baseApi().on('loadSessionPage', async (request: SessionHistoryPageRequest) => {
      most = Math.max(most, ++reading)
      await new Promise<void>(resolve => releases.push(resolve))
      reading--
      return resumeHistoryPage(page([userRow(request.sessionId, 'm-' + request.sessionId)]), request.knownHistoryBlocks ?? [])
    })
    const { world } = await readyHost(api)
    const sessions = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account')
    const cache = sessions.forHost('inst-a')
    // Saved after its last activity: current, so it is not read again.
    await cache.saveHistory('s2', page([userRow('current', 'm')]))
    const prefetch = new HistoryPrefetch({ cache: sessions, connection: id => world.connections.connection(id), inForeground: () => true })
    const records = Array.from({ length: 20 }, (_, index) => sessionRecord('s' + index, index === 2 ? 0 : Date.now() + 60_000))
    const warming = prefetch.warm('inst-a', records)
    await until(() => historyCalls(api).length === 8)
    await flushPromises()
    // The second batch waits until every read of the first batch has ended.
    expect(historyCalls(api)).toHaveLength(8)
    for (const release of releases.splice(0, 7)) release()
    await flushPromises()
    expect(historyCalls(api)).toHaveLength(8)
    for (const release of releases.splice(0)) release()
    await until(() => historyCalls(api).length === 16)
    for (const release of releases.splice(0)) release()
    await until(() => historyCalls(api).length === 19)
    for (const release of releases.splice(0)) release()
    await warming
    expect(most).toBe(8)
    expect(historyCalls(api).map(request => request.sessionId)).toEqual(records.map(record => record.sessionId).filter(id => id !== 's2'))
    expect(historyCalls(api)[0]).toEqual({ ...openingHistoryRequest(records[0]!), knownHistoryBlocks: [] })
    expect(historyCalls(api)[0]).not.toHaveProperty('openSession')
    expect((await cache.history('s19'))?.messages).toHaveLength(1)
  })

  test('a long list stops before its pages could push the top pages out of the device cache', async () => {
    const api = baseApi().on('loadSessionPage', async (request: SessionHistoryPageRequest) =>
      resumeHistoryPage(page([userRow(request.sessionId, 'm-' + request.sessionId)]), request.knownHistoryBlocks ?? []))
    const { world } = await readyHost(api)
    const sessions = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account')
    const prefetch = new HistoryPrefetch({ cache: sessions, connection: id => world.connections.connection(id), inForeground: () => true })
    await prefetch.warm('inst-a', Array.from({ length: 140 }, (_, index) => sessionRecord('s' + index, Date.now() + 60_000)))
    // The cache keeps 256 records per host for every kind of copy; the top 128 rows are half of it.
    expect(historyCalls(api)).toHaveLength(128)
    expect(historyCalls(api).at(-1)?.sessionId).toBe('s127')
  })

  test('large pages stop the warm when the pages it saved reach 16 MB', async () => {
    const text = 'x'.repeat(1_500_000)
    const api = baseApi().on('loadSessionPage', async (request: SessionHistoryPageRequest) =>
      resumeHistoryPage(page([userRow(text, 'm-' + request.sessionId)]), request.knownHistoryBlocks ?? []))
    const { world } = await readyHost(api)
    const sessions = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account')
    const prefetch = new HistoryPrefetch({ cache: sessions, connection: id => world.connections.connection(id), inForeground: () => true })
    await prefetch.warm('inst-a', Array.from({ length: 30 }, (_, index) => sessionRecord('s' + index, Date.now() + 60_000)))
    // Eight pages of 1.5 MB stay under the budget; sixteen pass it, so the third batch does not start.
    expect(historyCalls(api)).toHaveLength(16)
  })

  test('the background and a scope change stop it, and a read from the old scope is not kept', async () => {
    const answer = Promise.withResolvers<SessionHistoryPage>()
    const api = baseApi().on('loadSessionPage', () => answer.promise)
    const { world } = await readyHost(api)
    let scope = 'first'
    let foreground = false
    const sessions = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => scope)
    const prefetch = new HistoryPrefetch({ cache: sessions, connection: id => world.connections.connection(id), inForeground: () => foreground })
    await prefetch.warm('inst-a', [sessionRecord('s0', Date.now())])
    expect(historyCalls(api)).toHaveLength(0)
    foreground = true
    const warming = prefetch.warm('inst-a', [sessionRecord('s0', Date.now()), sessionRecord('s1', Date.now()), sessionRecord('s2', Date.now())])
    await until(() => historyCalls(api).length === 3)
    expect(historyCalls(api)).toHaveLength(3)
    scope = 'second'
    answer.resolve(page([userRow('old account', 'm')]))
    await warming
    expect(historyCalls(api)).toHaveLength(3)
    scope = 'first'
    expect(await sessions.forHost('inst-a').history('s0')).toBeNull()
  })
})

describe('session open', () => {
  afterEach(() => setOpenTimingSink(null))

  function controllerFor(connection: Awaited<ReturnType<typeof readyHost>>['connection'], sessionCache: ReturnType<MobileSessionCache['forHost']>) {
    const outboxStorage = memoryKeyValueStore()
    const target: ConversationTarget = { hostId: 'inst-a', record: { sessionId: 's1', provider: 'claude-code', projectPath: '/work/app', cwd: '/work/app', model: null, reasoningEffort: null, title: 'Fix it', customTitle: null } }
    return new ConversationController(target, {
      connection, sessionCache, outbox: new SendOutbox(() => outboxStorage),
      runSettings: async () => ({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} }),
      organizationId: () => null, uuid: () => crypto.randomUUID(), onChange: () => {},
    })
  }
  const texts = (controller: ConversationController) => controller.model.order.map(id => {
    const item = controller.model.items.get(id)
    return item && 'text' in item ? item.text : item?.kind
  })
  const recent = page([userRow('one', 'm1'), userRow('two', 'm2')], 'older')
  const opened = (request: SessionHistoryPageRequest) => ({
    ...resumeHistoryPage(recent, request.knownHistoryBlocks ?? []),
    ...(request.openSession && { openingDescription: { lineage: null, meta: null }, resumedWatch: { runtime: null } }),
  })

  test('an open with a saved page paints it at once and confirms it with one combined request', async () => {
    const answer = Promise.withResolvers<void>()
    const api = baseApi().on('loadSessionPage', async (request: SessionHistoryPageRequest) => { await answer.promise; return opened(request) })
    const { connection } = await readyHost(api)
    const sessions = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account')
    const cache = sessions.forHost('inst-a')
    await cache.saveHistory('s1', resumeHistoryPage(recent, []))
    const controller = controllerFor(connection, cache)
    const loading = controller.load()
    await until(() => texts(controller).length > 0)
    expect(texts(controller)).toEqual(['one', 'two'])
    const painted = controller.model
    answer.resolve()
    await loading
    expect(historyCalls(api)).toHaveLength(1)
    expect(historyCalls(api)[0]).toMatchObject({ openSession: true, turnLimit: 10 })
    expect(historyCalls(api)[0]!.knownHistoryBlocks!.length).toBeGreaterThan(0)
    expect(api.callsOf('describeSession')).toHaveLength(0)
    expect(api.callsOf('watchSession')).toHaveLength(0)
    expect(controller.model).toBe(painted)
    controller.close()
  })

  test('an open after a press takes the read the press started, and logs one timing line', async () => {
    const lines: SessionOpenTimingLine[] = []
    setOpenTimingSink(line => lines.push(line))
    const prefetchAnswer = Promise.withResolvers<void>()
    const api = baseApi().on('loadSessionPage', async (request: SessionHistoryPageRequest) => {
      if (!request.openSession) await prefetchAnswer.promise
      return opened(request)
    })
    const { world, connection } = await readyHost(api)
    const sessions = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account')
    const prefetch = new HistoryPrefetch({ cache: sessions, connection: id => world.connections.connection(id), inForeground: () => true })
    noteSessionPress('inst-a', 's1')
    void prefetch.prefetch('inst-a', sessionRecord('s1'))
    void prefetch.prefetch('inst-a', sessionRecord('s1'))
    const controller = controllerFor(connection, sessions.forHost('inst-a'))
    const loading = controller.load()
    await until(() => historyCalls(api).length > 0)
    await new Promise(resolve => setTimeout(resolve, 60))
    // The open waits for the press's read; it does not send a second full read.
    expect(historyCalls(api)).toHaveLength(1)
    prefetchAnswer.resolve()
    await loading
    expect(texts(controller)).toEqual(['one', 'two'])
    expect(historyCalls(api)).toHaveLength(2)
    expect(historyCalls(api)[1]).toMatchObject({ openSession: true, turnLimit: 10 })
    expect(historyCalls(api)[1]!.knownHistoryBlocks!.length).toBeGreaterThan(0)
    expect(api.callsOf('describeSession')).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ event: 'session_open_painted', sessionId: 's1', source: 'prefetch' })
    expect(lines[0]!.pressToOpenMs).toBeNumber()
    expect(lines[0]!.prefetchWaitMs).toBeNumber()
    expect(lines[0]!.buildMs).toBeNumber()
    expect(lines[0]!.totalMs).toBeGreaterThanOrEqual(lines[0]!.renderMs)
    controller.close()
  })
})
