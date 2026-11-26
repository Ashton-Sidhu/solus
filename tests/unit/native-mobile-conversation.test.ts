import { describe, expect, test } from 'bun:test'
import { resumeHistoryPage } from '@solus/server/data/sessions/history-blocks'
import { withTurnItemBodies } from '@solus/server/data/sessions/result-projection'
import { MobileSessionCache } from '../../apps/mobile/solus-core/features/threads/session-cache'
import { PullRequestCache, memoryPullRequestCacheDatabase } from '@solus/client-core/pull-request-cache'
import { SendOutbox } from '@solus/client-core/send-outbox'
import { HostRpcError, TransportDisconnectedError } from '@solus/client-core/rpc-error'
import { REQUEST_NOT_ANSWERABLE_CODE, requestExpiryText } from '@solus/contracts/types'
import type { IpcContext, PromptOptions, WireNormalizedEvent } from '@solus/contracts/types'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { ConversationController, type ConversationDeps, type ConversationTarget } from '../../apps/mobile/solus-core/features/conversation/conversation-controller'
import { SolusApp } from '../../apps/mobile/solus-core/app/solus-app'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/solus-core/platform/ports'
import { createHostWorld, FakeApi, flushPromises, healthFetch, FakeTransport } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'
import { TranscriptModel } from '../../apps/mobile/solus-core/features/conversation/lib/transcript-model'
import { artifactHtmlRender, type ArtifactRender } from '../../apps/mobile/solus-core/features/conversation/lib/artifacts'
import { UNMEASURED_REPLY_HEIGHT } from '@solus/contracts/session-history'

const page = (messages: SessionHistoryPage['messages'], before: string | null = null): SessionHistoryPage => ({ messages, before })
const userRow = (content: string, messageId: string) => ({ role: 'user', content, messageId, timestamp: 1 })
const assistantRow = (content: string, messageId: string) => ({ role: 'assistant', content, messageId, timestamp: 2 })

function record(provider: 'claude-code' | 'codex' = 'claude-code'): NonNullable<ConversationTarget['record']> {
  return { sessionId: 'thread-1', provider, projectPath: '/work/app', cwd: '/work/app', model: null, reasoningEffort: null, title: 'Fix it', customTitle: null }
}

interface Setup {
  hasReplacement?(): boolean
  isIOS?: boolean
  api: FakeApi
  runSettings?: ConversationDeps['runSettings']
  sessionCache?: ReturnType<MobileSessionCache['forHost']>
  target?: ConversationTarget
}

async function open(setup: Setup) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => setup.api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection('inst-a')!
  const transport = world.transports[0] as FakeTransport
  await transport.accept()
  const outboxStorage = memoryKeyValueStore()
  const outbox = new SendOutbox(() => outboxStorage)
  let nextId = 0
  const changes: Array<{ items: string[]; order: boolean; meta: boolean }> = []
  const controller = new ConversationController(setup.target ?? { hostId: 'inst-a', record: record() }, {
    connection,
    sessionCache: setup.sessionCache,
    isIOS: setup.isIOS,
    hasReplacement: setup.hasReplacement,
    outbox,
    runSettings: setup.runSettings ?? (async () => ({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} })),
    organizationId: () => null,
    uuid: () => `client-${++nextId}`,
    onChange: (change) => changes.push(change),
  })
  return { world, transport, connection, controller, outbox, changes }
}

function baseApi(): FakeApi {
  return new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => page([userRow('hello', 'm1'), assistantRow('hi there', 'm2')]))
    .on('watchSession', () => ({ runtime: null }))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => Date.now())
    .on('prompt', () => ({ disposition: 'started' }))
}

/** The conversation's own calls, without the per-connection capability, server-info
 *  (the host introducer's read of a ready host), and agent reads, the run-option
 *  read beside history, and the reads of the session's suggestions, background records, and folders. */
// The host's policy is a shared host fact (plans/030 §7), read once per host, not a call of this conversation.
const conversationCalls = (api: FakeApi) => api.calls.map((call) => call.method).filter((method) => method !== 'hostPolicy')
  .filter((method) => method !== 'serverGetCapabilities' && method !== 'connectionsGetServerInfo' && method !== 'start' && method !== 'configGet' && method !== 'setSessionReadState' && method !== 'sessionSuggestions' && method !== 'mcpTaskList' && method !== 'integrationResourceWatchList' && method !== 'sessionFolders' && method !== 'typeSafeKeyStatus')

const texts = (controller: ConversationController) => controller.model.order.map((id) => {
  const item = controller.model.items.get(id)
  return item && 'text' in item ? `${item.kind}:${item.text}` : item?.kind
})

describe('native conversation: history and live events', () => {
  const largeSessionBytes = 16 * 1024 * 1024
  test.each([true, false])('a cold page describes the session and starts one watch (iOS %s)', async isIOS => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const api = baseApi().on('loadSessionPage', (request: SessionHistoryPageRequest) => {
      expect(request.openSession).toBe(true)
      return { ...page([assistantRow('latest', 'm1')]), openingDescription: { meta: null, lineage: null }, resumedWatch: { runtime: null } }
    })
    const { controller } = await open({ api, isIOS, sessionCache: { ...cache, hasHistoryKey: () => false } })
    await controller.load()
    expect(texts(controller)).toEqual(['assistant:latest'])
    expect(api.callsOf('describeSession')).toHaveLength(0)
    expect(api.callsOf('watchSession')).toHaveLength(0)
    expect(await cache.history('thread-1')).not.toHaveProperty('resumedWatch')
    controller.close()
    expect(api.callsOf('unwatchSession')).toHaveLength(1)
  })

  test.each([
    { name: 'large iOS session with an empty cache', isIOS: true, size: largeSessionBytes, saved: false, turns: 2 },
    { name: 'one byte below the cutoff', isIOS: true, size: largeSessionBytes - 1, saved: false, turns: 5 },
    { name: 'large iOS session with a missing saved page', isIOS: true, size: largeSessionBytes, saved: true, turns: 2 },
    { name: 'unknown cache state', isIOS: true, size: largeSessionBytes, saved: undefined, turns: 10 },
    { name: 'unknown session size', isIOS: true, size: undefined, saved: false, turns: 5 },
    { name: 'large Android session', isIOS: false, size: largeSessionBytes, saved: false, turns: 5 },
  ])('opens $name with $turns turns', async ({ isIOS, size, saved, turns }) => {
    const api = baseApi().on('loadSessionPage', (request: SessionHistoryPageRequest) => request.before
      ? page([userRow('earlier', 'm0')])
      : page([assistantRow('latest', 'm1')], 'older'))
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const { controller } = await open({ api, isIOS, sessionCache: { ...cache, hasHistoryKey: () => saved },
      target: { hostId: 'inst-a', record: { ...record(), size } } })
    await controller.load()
    expect(api.callsOf('loadSessionPage')[0]?.[0]).toMatchObject({ turnLimit: turns })
    await controller.loadOlder()
    expect(api.callsOf('loadSessionPage')[1]?.[0]).toMatchObject({ turnLimit: 20, before: 'older' })
    expect(texts(controller)).toEqual(['user:earlier', 'assistant:latest'])
    await controller.load()
    expect(api.callsOf('loadSessionPage')[2]?.[0]).toMatchObject({ turnLimit: 10 })
    controller.close()
  })

  test('reopens a verified two-turn page and prepends eight turns without replacing the visible rows', async () => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const recent = page([userRow('nine', 'm9'), userRow('ten', 'm10')], '8')
    await cache.saveHistory('thread-1', resumeHistoryPage(recent, []))
    const release = Promise.withResolvers<void>()
    const api = baseApi().on('loadSessionPage', async (request: SessionHistoryPageRequest) => {
      if (!request.before) {
        await release.promise
        const checked = resumeHistoryPage(recent, request.knownHistoryBlocks ?? [])
        return request.openSession ? { ...checked, resumedWatch: { runtime: null }, openingDescription: { lineage: null, meta: null } } : checked
      }
      const last = Number(request.before)
      return page([userRow(String(last - 1), 'm' + (last - 1)), userRow(String(last), 'm' + last)], String(last - 2))
    })
    const { controller } = await open({ api, isIOS: true, sessionCache: cache,
      target: { hostId: 'inst-a', record: { ...record(), size: largeSessionBytes } } })
    const loading = controller.load()
    await flushPromises()
    expect(texts(controller)).toEqual(['user:nine', 'user:ten'])
    const model = controller.model
    const last = model.items.get(model.order.at(-1)!)
    release.resolve()
    await loading
    expect(api.callsOf('loadSessionPage')[0]?.[0]).toMatchObject({ turnLimit: 2 })
    expect(controller.model).toBe(model)
    expect(api.callsOf('watchSession')).toHaveLength(0)
    expect(api.callsOf('describeSession')).toHaveLength(0)
    expect((await cache.history('thread-1'))?.resumedWatch).toBeUndefined()
    expect(api.callsOf('loadSessionPage')).toHaveLength(2)
    expect(api.callsOf('loadSessionPage')[1]?.[0]).toMatchObject({ before: '8', turnLimit: 2 })
    expect(texts(controller)).toEqual(['user:nine', 'user:ten'])
    const drag = Promise.withResolvers<void>()
    const filling = controller.fillOpeningHistory(() => drag.promise)
    await flushPromises()
    expect(texts(controller)).toEqual(['user:nine', 'user:ten'])
    await controller.fillOpeningHistory()
    expect(api.callsOf('loadSessionPage')).toHaveLength(2)
    drag.resolve()
    await filling
    for (let i = 0; i < 4; i++) await controller.fillOpeningHistory()
    expect(api.callsOf('loadSessionPage').slice(1)).toMatchObject(
      ['8', '6', '4', '2'].map(before => [{ before, turnLimit: 2 }]))
    expect(texts(controller)).toEqual(['user:1', 'user:2', 'user:3', 'user:4', 'user:5', 'user:6', 'user:7', 'user:8', 'user:nine', 'user:ten'])
    expect(controller.model.items.get(model.order.at(-1)!)).toBe(last)
    controller.close()
  })

  test('a changed opening page discards its speculative older read even if the cursor is unchanged', async () => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    await cache.saveHistory('thread-1', resumeHistoryPage(page([userRow('before edit', 'm9')], '8'), []))
    let reads = 0
    const api = baseApi().on('loadSessionPage', (request: SessionHistoryPageRequest) => {
      if (!request.before) return resumeHistoryPage(page([userRow('edited', 'm9')], '8'), request.knownHistoryBlocks ?? [])
      reads++
      return page([userRow(reads === 1 ? 'stale' : 'current', 'm8')])
    })
    const { controller } = await open({ api, isIOS: true, sessionCache: cache,
      target: { hostId: 'inst-a', record: { ...record(), size: largeSessionBytes } } })
    await controller.load()
    expect(api.callsOf('watchSession')).toHaveLength(1)
    await controller.fillOpeningHistory()
    expect(reads).toBe(2)
    expect(texts(controller)).toEqual(['user:current', 'user:edited'])
    controller.close()
  })

  test.each([false, true])('a late watch confirmation releases a closed store unless another store owns it (replacement %s)', async hasReplacement => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const recent = page([userRow('saved', 'm1')])
    const saved = resumeHistoryPage(recent, [])
    await cache.saveHistory('thread-1', saved)
    const received = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const api = baseApi().on('loadSessionPage', async (request: SessionHistoryPageRequest) => {
      expect(request.openSession).toBe(true)
      received.resolve()
      await release.promise
      return { ...resumeHistoryPage(recent, request.knownHistoryBlocks!), resumedWatch: { runtime: null }, openingDescription: { lineage: null, meta: null } }
    })
    const { controller } = await open({ api, isIOS: true, sessionCache: cache, hasReplacement: () => hasReplacement })
    const opening = controller.load()
    await received.promise
    controller.close()
    release.resolve()
    await opening
    expect(api.callsOf('unwatchSession')).toHaveLength(hasReplacement ? 0 : 1)
  })

  test('the first older page can scroll into view while composer settings are still loading', async () => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const watchStarted = Promise.withResolvers<void>()
    const settings = Promise.withResolvers<Awaited<ReturnType<ConversationDeps['runSettings']>>>()
    const recent = page([userRow('recent', 'm2')], 'older')
    await cache.saveHistory('thread-1', resumeHistoryPage(recent, []))
    const api = baseApi().on('loadSessionPage', (request: SessionHistoryPageRequest) => request.before
      ? page([userRow('earlier', 'm1')])
      : resumeHistoryPage(recent, request.knownHistoryBlocks ?? []))
    api.on('watchSession', () => { watchStarted.resolve(); return { runtime: null } })
    const { controller } = await open({ api, isIOS: true, sessionCache: cache, runSettings: () => settings.promise,
      target: { hostId: 'inst-a', record: { ...record(), size: largeSessionBytes } } })
    const loading = controller.load()
    await watchStarted.promise
    expect(controller.phase.kind).toBe('loading')
    expect(controller.canFillOpeningHistory).toBe(true)
    await controller.fillOpeningHistory()
    expect(texts(controller)).toEqual(['user:earlier', 'user:recent'])
    settings.resolve({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} })
    await loading
    expect(texts(controller)).toEqual(['user:earlier', 'user:recent'])
    controller.close()
  })

  test('a large session with ten turns already on disk confirms the full saved window', async () => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const full = page(Array.from({ length: 10 }, (_, i) => userRow('prompt ' + i, 'm' + i)), 'earlier')
    await cache.saveHistory('thread-1', resumeHistoryPage(full, []))
    const api = baseApi().on('loadSessionPage', (request: SessionHistoryPageRequest) => resumeHistoryPage(full, request.knownHistoryBlocks ?? []))
    const { controller } = await open({ api, isIOS: true, sessionCache: cache,
      target: { hostId: 'inst-a', record: { ...record(), size: largeSessionBytes } } })
    await controller.load()
    expect(api.callsOf('loadSessionPage')).toMatchObject([[{ turnLimit: 10 }]])
    expect(controller.canFillOpeningHistory).toBe(false)
    expect(texts(controller)).toHaveLength(10)
    controller.close()
  })

  test('a known disk miss sends history before navigation can occupy the JS thread', async () => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    await cache.saveHistory('another-session', page([]))
    const api = baseApi()
    const disk = Promise.withResolvers<SessionHistoryPage | null>()
    const { controller } = await open({ api, sessionCache: { ...cache, history: () => disk.promise } })
    const loading = controller.load()
    expect(api.callsOf('loadSessionPage')[0]?.[0]).toMatchObject({ sessionId: 'thread-1', knownHistoryBlocks: [], turnItems: true })
    disk.resolve(null)
    await loading
    controller.close()
  })

  test('reads pre-upgrade history and clears both saved formats when access ends', async () => {
    const storage = new PullRequestCache(memoryPullRequestCacheDatabase())
    let scope = 'first'
    const caches = new MobileSessionCache(storage, () => scope)
    const cache = caches.forHost('host')
    const key = JSON.stringify(['sessions-v1', scope, 'history', 's'])
    const old = page([assistantRow('old page', 'a')])
    const current = page(withTurnItemBodies([assistantRow('new page', 'a')]))
    await storage.write('host', key, old)
    expect(await cache.history('s')).toEqual(old)
    await cache.saveHistory('s', current)
    expect(await cache.history('s')).toEqual(current)
    expect(await storage.read('host', key)).toEqual(old)
    scope = 'second'
    expect(await cache.history('s')).toBeNull()
    expect(await caches.forHost('host').history('s')).toBeNull()
    scope = 'first'
    await cache.saveHistory('s', null)
    expect(await storage.read('host', key)).toBeNull()
    expect(await cache.history('s')).toBeNull()
  })

  test('a projected call on an older page receives its newer result and survives a live reconnect', async () => {
    const api = baseApi().on('loadSessionPage', (request: SessionHistoryPageRequest) => {
      expect(request.turnItems).toBe(true)
      return request.before ? page(withTurnItemBodies([
        userRow('open it', 'u'),
        { role: 'tool', toolName: 'Read', toolId: 'call', toolInput: '{"path":"old"}', messageId: 't', content: '', timestamp: 1 },
      ])) : page(withTurnItemBodies([
        { role: 'tool_result', content: '', toolResultForId: 'call', status: 'error', errorHead: 'missing', timestamp: 2 },
        assistantRow('saved reply', 'a'),
      ]), 'older')
    })
    const { controller, transport } = await open({ api })
    await controller.load()
    await controller.loadOlder()
    expect(texts(controller)).toEqual(['user:open it', 'tool', 'assistant:saved reply'])
    expect(controller.model.items.get('t')).toMatchObject({ input: '{"path":"old"}', status: 'error', errorHead: 'missing' })
    transport.emit('session.eventReceived', { sessionId: 'thread-1', cursor: 'epoch.1', event: { type: 'text_chunk', text: 'live' } })
    api.on('watchSession', () => {
      transport.emit('session.eventReceived', { sessionId: 'thread-1', cursor: 'epoch.2', event: { type: 'text_chunk', text: ' tail' } })
      return { resumed: true }
    })
    await transport.accept(false)
    await flushPromises()
    expect(texts(controller)).toEqual(['user:open it', 'tool', 'assistant:saved reply', 'assistant:live tail'])
    expect(api.callsOf('loadSessionPage')).toHaveLength(2)
    controller.close()
  })

  test('a saved page shows its session link without the agent instruction', async () => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const typed = 'Review [the earlier session](session://ref?sessionId=prior&provider=codex).'
    const content = [
      typed,
      '',
      '[Referenced Session: "the earlier session" (session_id: prior, provider: codex)]',
      'Call read_session with session_id "prior" to read its transcript before responding.',
    ].join('\n')
    const saved = page([userRow(content, 'm1')])
    await cache.saveHistory('thread-1', saved)
    const pending = Promise.withResolvers<SessionHistoryPage>()
    const { controller } = await open({ api: baseApi().on('loadSessionPage', () => pending.promise), sessionCache: cache })
    const loading = controller.load()
    await flushPromises()
    expect(texts(controller)).toEqual([`user:${typed}`])
    pending.resolve(saved)
    await loading
    expect(texts(controller)).toEqual([`user:${typed}`])
    controller.close()
  })

  test('opens the cached page before the host replies and removes it when the host denies access', async () => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    await cache.saveHistory('thread-1', page([userRow('cached', 'm0')], 'older'))
    const pending = Promise.withResolvers<SessionHistoryPage>()
    const api = baseApi().on('loadSessionPage', () => pending.promise)
    const { controller } = await open({ api, sessionCache: cache })
    const loading = controller.load()
    await flushPromises()
    expect(texts(controller)).toEqual(['user:cached'])
    pending.resolve(page([userRow('fresh', 'm1')]))
    await loading
    expect(texts(controller)).toEqual(['user:fresh'])
    expect((await cache.history('thread-1'))?.before).toBeNull()
    api.on('loadSessionPage', () => { throw new HostRpcError('Access denied', 'FORBIDDEN') })
    await controller.load()
    expect(controller.phase).toMatchObject({ kind: 'error', noAccess: true })
    expect(texts(controller)).toEqual([])
    expect(await cache.history('thread-1')).toBeNull()
    controller.close()
  })

  test('a cold open shows the first authorized page while the host still describes the session', async () => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const description = Promise.withResolvers<null>()
    const api = baseApi().on('describeSession', () => description.promise)
    const { controller } = await open({ api, sessionCache: cache })
    const loading = controller.load()
    await flushPromises()
    expect(texts(controller)).toEqual(['user:hello', 'assistant:hi there'])
    const firstModel = controller.model
    description.resolve(null)
    await loading
    expect(controller.model).toBe(firstModel)
    expect(api.callsOf('loadSessionPage')).toHaveLength(1)
    expect((await cache.history('thread-1'))?.messages).toHaveLength(2)
    controller.close()
  })

  test.each([true, false])('a slow phone cache cannot hold or replace a host page (has messages: %s)', async (hasMessages) => {
    const saved = Promise.withResolvers<SessionHistoryPage | null>()
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const description = Promise.withResolvers<null>()
    const api = baseApi().on('describeSession', () => description.promise)
    if (!hasMessages) api.on('loadSessionPage', () => page([]))
    const expected = hasMessages ? ['user:hello', 'assistant:hi there'] : []
    const { controller } = await open({ api, sessionCache: { ...cache, history: () => saved.promise } })
    const opening = controller.load()
    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(api.callsOf('loadSessionPage')).toHaveLength(1)
      expect(texts(controller)).toEqual(expected)
      saved.resolve(page([userRow('stale', 'old')]))
      await flushPromises()
      expect(texts(controller)).toEqual(expected)
    } finally {
      saved.resolve(null)
      description.resolve(null)
      await opening
      controller.close()
    }
  })

  test('shows the saved conversation before the host answers model settings', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ConversationDeps['runSettings']>>>()
    const { controller } = await open({ api: baseApi(), runSettings: () => gate.promise })
    const loading = controller.load()
    await flushPromises()
    expect(texts(controller)).toContain('user:hello')
    gate.resolve({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} })
    await loading
    controller.close()
  })

  test('publishes history while the live watch is still pending', async () => {
    let finishWatch!: (value: { runtime: null }) => void
    const api = baseApi().on('watchSession', () => new Promise<{ runtime: null }>((resolve) => { finishWatch = resolve }))
    const { controller, changes } = await open({ api })
    const loading = controller.load()
    await flushPromises()
    // A slow live subscription must not hide history that has already arrived.
    expect(changes.some((change) => change.order)).toBe(true)
    expect(texts(controller)).toEqual(['user:hello', 'assistant:hi there'])
    expect(controller.phase.kind).toBe('loading')
    finishWatch({ runtime: null })
    await loading
    expect(controller.phase.kind).toBe('ready')
    controller.close()
  })

  test('loads history before joining the live stream and holds events that arrive meanwhile', async () => {
    let releasePage!: (value: SessionHistoryPage) => void
    const api = baseApi().on('loadSessionPage', () => new Promise<SessionHistoryPage>((resolve) => { releasePage = resolve }))
    const { controller, transport } = await open({ api })
    const loading = controller.load()
    await flushPromises()
    // The open is one request; this host does not answer its description, so it is read after the page.
    expect(conversationCalls(api)).toEqual(['loadSessionPage'])

    // An event for this session while history is in flight is held, not applied.
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'later' })
    expect(controller.model.order).toEqual([])

    releasePage(page([userRow('hello', 'm1')]))
    await loading
    expect(conversationCalls(api)).toEqual(['loadSessionPage', 'describeSession', 'watchSession'])
    expect(api.callsOf('watchSession')[0]?.[0]).toEqual({ sessionId: 'thread-1', attachRuntime: true })
    expect(texts(controller)).toEqual(['user:hello', 'assistant:later'])
    expect(controller.phase).toEqual({ kind: 'ready' })
    expect(api.callsOf('setSessionReadState')[0]?.[0]).toBe('thread-1')
    expect(api.callsOf('setSessionReadState')[0]?.[1]).toBeNumber()
  })

  test('keeps the session id it opened and streams into one assistant row', async () => {
    // WHY: a session has one id everywhere (docs/plans/session-identity.md);
    // the watch never renames it.
    const api = baseApi().on('watchSession', () => ({ runtime: { status: 'running', modelConfig: null, permissionMode: null, queuedPrompts: [], rateLimitInfo: null } }))
    const { controller, transport, changes } = await open({ api })
    await controller.load()
    expect(controller.run.sessionId).toBe('thread-1')
    expect(controller.model.status).toBe('running')

    changes.length = 0
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'Hel' })
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'lo' })
    expect(texts(controller)).toEqual(['user:hello', 'assistant:hi there', 'assistant:Hello'])
    // The second token changes one row and does not re-order the list.
    expect(changes[1]).toEqual({ items: [controller.model.order[2]!], order: false, meta: false })
  })

  test('a reconnect that lost the server session reloads history and watches again', async () => {
    const api = baseApi()
    const { controller, transport } = await open({ api })
    await controller.load()
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'partial' })
    api.on('loadSessionPage', () => page([userRow('hello', 'm1'), assistantRow('hi there', 'm2'), assistantRow('partial and more', 'm3')]))

    await transport.accept(false)
    await flushPromises()
    expect(api.callsOf('loadSessionPage')).toHaveLength(2)
    expect(api.callsOf('watchSession')).toHaveLength(2)
    expect(texts(controller)).toEqual(['user:hello', 'assistant:hi there', 'assistant:partial and more'])

    await transport.accept(true)
    await flushPromises()
    // A recovered socket continues the same server session.
    expect(api.callsOf('loadSessionPage')).toHaveLength(2)
  })

  test('an older load that answers after a newer one is dropped', async () => {
    const answers: Array<(value: SessionHistoryPage) => void> = []
    const api = baseApi().on('loadSessionPage', () => new Promise<SessionHistoryPage>((resolve) => { answers.push(resolve) }))
    const { controller } = await open({ api })
    const first = controller.load()
    await flushPromises()
    const second = controller.load()
    await flushPromises()
    answers[1]?.(page([userRow('new', 'n1')]))
    await second
    answers[0]?.(page([userRow('stale', 's1')]))
    await first
    expect(texts(controller)).toEqual(['user:new'])
    expect(api.callsOf('watchSession')).toHaveLength(1)
  })

  test('loads an older page before what is shown', async () => {
    const api = baseApi()
      .on('loadSessionPage', (request: SessionHistoryPageRequest) => request.before
        ? page([userRow('first ever', 'o1')], null)
        : page([userRow('hello', 'm1')], 'cursor-1'))
    const { controller } = await open({ api })
    await controller.load()
    await controller.loadOlder()
    expect(texts(controller)).toEqual(['user:first ever', 'user:hello'])
    expect(api.callsOf('loadSessionPage')[1]?.[0]).toMatchObject({ before: 'cursor-1', turnLimit: 20 })
    expect(controller.model.olderCursor).toBeNull()
  })

  test('a jump tells the host which message to include and prepends its continuous page once', async () => {
    const api = baseApi().on('loadSessionPage', (request: SessionHistoryPageRequest) => {
      if (!request.before) return page([userRow('current', 'm3')], 'older')
      const nearer = userRow('intervening', 'm2')
      return request.throughEntryId === 'm1'
        ? page([userRow('destination', 'm1'), nearer], null)
        : page([nearer], 'oldest')
    })
    const { controller } = await open({ api })
    await controller.load()
    await controller.loadOlder('m1')
    expect(texts(controller)).toEqual(['user:destination', 'user:intervening', 'user:current'])
    expect(api.callsOf('loadSessionPage')).toHaveLength(2)
    expect(controller.model.olderCursor).toBeNull()
  })

  test('a failed older page keeps its rows and cursor until a retry succeeds', async () => {
    const api = baseApi().on('loadSessionPage', (request: SessionHistoryPageRequest) => {
      if (request.before) throw new Error('Host offline')
      return page([userRow('newest', 'm1')], 'earlier')
    })
    const { controller } = await open({ api })
    await controller.load()
    await controller.loadOlder()
    expect(controller.model.history).toMatchObject({ historyCursor: 'earlier', loading: false, error: 'Host offline' })
    expect(texts(controller)).toEqual(['user:newest'])
    api.on('loadSessionPage', () => page([userRow('older', 'm0')], null))
    await controller.loadOlder()
    expect(controller.model.history).toMatchObject({ historyCursor: null, loading: false, error: null })
    expect(texts(controller)).toEqual(['user:older', 'user:newest'])
  })

  test('reads the first page while the session is described, and again only when the thread moved provider', async () => {
    // WHY: on a remote host each read is a round trip. The page must not wait
    // for the description, but a session handed off to another provider must
    // show that provider's transcript, not the one the record named.
    let describe!: (value: unknown) => void
    const lineage = (provider: 'claude-code' | 'codex') => ({
      sessionId: 'thread-1', lineageToken: 't', members: [],
      active: { position: 0, provider, providerSessionId: 'p-1', cwd: '/work/app', startedAt: 1, endedAt: null },
    })
    for (const [activeProvider, pageReads] of [['claude-code', 1], ['codex', 2]] as const) {
      const api = baseApi().on('describeSession', () => new Promise((resolve) => { describe = resolve }))
      const { controller } = await open({ api })
      const loading = controller.load()
      await flushPromises()
      expect(api.callsOf('loadSessionPage')).toHaveLength(1)
      describe({ lineage: lineage(activeProvider), meta: null })
      await loading
      expect(api.callsOf('loadSessionPage')).toHaveLength(pageReads)
      expect(api.callsOf('loadSessionPage').at(-1)?.[0]).toMatchObject({ provider: activeProvider })
      expect(texts(controller)).toEqual(['user:hello', 'assistant:hi there'])
    }
  })

  test('a first page from the previous provider cannot paint over the handoff its open answer names', async () => {
    // WHY: the open's answer carries the page and the lineage together. When
    // the lineage names another provider, that page is the old transcript.
    const prior = Promise.withResolvers<SessionHistoryPage>()
    const current = Promise.withResolvers<SessionHistoryPage>()
    const api = baseApi()
      .on('loadSessionPage', (request: SessionHistoryPageRequest) => request.provider === 'codex' ? current.promise : prior.promise)
    const { controller } = await open({ api })
    const loading = controller.load()
    await flushPromises()
    prior.resolve({ ...page([assistantRow('previous provider', 'a')]),
      openingDescription: { lineage: { active: { provider: 'codex', providerSessionId: 'new' } } } } as SessionHistoryPage)
    await flushPromises()
    expect(texts(controller)).toEqual([])
    current.resolve(page([assistantRow('current provider', 'b')]))
    await loading
    expect(texts(controller)).toEqual(['assistant:current provider'])
    expect(api.callsOf('describeSession')).toHaveLength(0)
    controller.close()
  })

  test('opens a Codex session with its own provider on every call', async () => {
    const api = baseApi()
    const { controller } = await open({ api, target: { hostId: 'inst-a', record: record('codex') } })
    await controller.load()
    expect(api.callsOf('describeSession')[0]).toEqual(['thread-1'])
    expect(api.callsOf('loadSessionPage')[0]?.[0]).toMatchObject({ provider: 'codex' })
    await controller.send('go')
    const [ctx] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(ctx.session.provider).toBe('codex')
  })

  test('closing unwatches and stops listening', async () => {
    const api = baseApi()
    const { controller, transport } = await open({ api })
    await controller.load()
    controller.close()
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'after close' })
    await flushPromises()
    expect(api.callsOf('unwatchSession')).toEqual([['thread-1']])
    expect(texts(controller)).toEqual(['user:hello', 'assistant:hi there'])
  })
})

describe('native conversation: sending', () => {
  test('a text send can use the pending feed without rebuilding loaded history before the host replies', async () => {
    const reply = Promise.withResolvers<{ disposition: 'started' }>()
    const history = Array.from({ length: 500 }, (_, index) => userRow('earlier prompt', 'm' + index))
    const api = baseApi().on('loadSessionPage', () => page(history)).on('prompt', () => reply.promise)
    const { controller, transport } = await open({ api })
    await controller.load()
    const order = controller.model.order
    const sending = controller.send('next step', { pendingMessage: { messageId: 'phone-message', commandId: 'command', createdAt: '2026-11-24T12:00:00Z' } })
    await flushPromises()
    expect(controller.model.order).toBe(order)
    expect(controller.pendingText).toMatchObject({ messageId: 'phone-message', text: 'next step' })
    expect(api.callsOf('prompt')[0]?.[1]).toMatchObject({ clientPromptId: 'phone-message' })
    transport.emitSession('thread-1', { type: 'status_change', status: 'running' })
    await flushPromises()
    expect(controller.model.status).toBe('running')
    expect(controller.pendingText?.messageId).toBe('phone-message')
    expect(controller.model.order).toBe(order)
    transport.emitSession('thread-1', { type: 'user_message', clientPromptId: 'phone-message', text: 'next step' })
    reply.resolve({ disposition: 'started' })
    await sending
    expect(controller.pendingText).toBeNull()
    expect(controller.model.order).toEqual([...order, 'phone-message'])
    expect(controller.model.items.get('phone-message')).toMatchObject({ text: 'next step', delivery: 'sent' })
  })

  test('a first text prompt can leave its draft after local save, before host acceptance', async () => {
    const reply = Promise.withResolvers<{ disposition: 'started' }>()
    const api = baseApi().on('prompt', () => reply.promise)
    const { controller, outbox } = await open({ api, target: { hostId: 'inst-a', newSession: {
      sessionId: 'draft', provider: 'codex', workingDirectory: '/work/app',
    } } })
    await controller.load()
    const queued: string[] = []
    const sending = controller.send('first', { pendingMessage: { messageId: 'message', commandId: 'command', createdAt: '2026-11-24T12:00:00Z' }, onQueued: (id) => {
      queued.push(...outbox.entriesFor('inst-a/draft').map(entry => entry.clientPromptId))
      expect(id).toBe('message')
    } })
    await flushPromises()
    expect(queued).toEqual(['message'])
    expect(controller.pendingText?.text).toBe('first')
    reply.resolve({ disposition: 'started' })
    await sending
    expect(controller.pendingText).toBeNull()
    expect(texts(controller)).toEqual(['user:first'])
  })

  test('local save failure clears the pending feed and leaves the host untouched', async () => {
    const api = baseApi()
    const { controller, outbox } = await open({ api })
    await controller.load()
    const before = controller.model.order
    outbox.enqueue = () => false
    await expect(controller.send('try again', { pendingMessage: { messageId: 'failed', commandId: 'command', createdAt: '2026-11-24T12:00:00Z' } })).rejects.toThrow('local outbox')
    expect(controller.pendingText).toBeNull()
    expect(controller.model.order).toBe(before)
    expect(controller.model.status).toBe('idle')
    expect(api.callsOf('prompt')).toHaveLength(0)
  })

  test('Codex /compact calls the host command without a prompt bubble or an outbox entry', async () => {
    // WHY: Native and desktop must invoke the same command instead of sending text to Codex.
    const api = baseApi().on('compactSession', () => undefined)
    const { controller, outbox } = await open({ api, target: { hostId: 'inst-a', record: record('codex') } })
    await controller.load()
    const before = texts(controller)
    await controller.send('/compact')
    expect(api.callsOf('compactSession')).toHaveLength(1)
    expect(api.callsOf('compactSession')[0]?.[0]).toMatchObject({ session: { sessionId: 'thread-1', agentSessionId: 'thread-1', provider: 'codex' } })
    expect(api.callsOf('prompt')).toHaveLength(0)
    expect(outbox.entriesFor(controller.outboxKey)).toEqual([])
    expect(texts(controller)).toEqual(before)
    controller.close()
  })

  test('Codex /compact shows draft and busy refusal messages without a false busy state', async () => {
    const api = baseApi().on('compactSession', () => { throw new Error('Wait for the current turn to finish.') })
    const { controller } = await open({ api, target: { hostId: 'inst-a', newSession: { sessionId: 'draft-1', provider: 'codex', workingDirectory: '/work/app' } } })
    await controller.load()
    await controller.send('/compact')
    expect(api.callsOf('compactSession')).toHaveLength(0)
    expect(texts(controller).some((text) => text?.includes('Send a first message'))).toBe(true)
    expect(controller.model.status).toBe('idle')
    controller.run.agentSessionId = 'codex-thread'
    controller.model.setStatus('running')
    await controller.send('/compact')
    expect(texts(controller).some((text) => text?.includes('Wait for the current turn'))).toBe(true)
    expect(controller.model.status).toBe('running')
    expect(api.callsOf('prompt')).toHaveLength(0)
    controller.close()
  })

  test('Claude /compact keeps the provider command path', async () => {
    const api = baseApi()
    const { controller } = await open({ api })
    await controller.load()
    await controller.send('/compact')
    expect(api.callsOf('compactSession')).toHaveLength(0)
    expect(api.callsOf('prompt')).toHaveLength(1)
    expect(api.callsOf('prompt')[0]?.[1]).toMatchObject({ prompt: '/compact' })
    controller.close()
  })

  test('a new session watches, then prompts with no provider thread, and learns it from session_init', async () => {
    const api = new FakeApi()
      .on('watchSession', () => ({}))
      .on('prompt', () => ({ disposition: 'started' }))
    const { controller, transport } = await open({ api, target: { hostId: 'inst-a', newSession: { sessionId: 'new-1', provider: 'claude-code', workingDirectory: '/work/app' } } })
    await controller.load()
    await controller.send('build it')
    expect(conversationCalls(api)).toEqual(['watchSession', 'prompt'])
    const [ctx, options] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(ctx.session).toMatchObject({ sessionId: 'new-1', agentSessionId: null, provider: 'claude-code', workingDirectory: '/work/app', permissionMode: 'auto' })
    // The person's preferences are not in the context: the host reads its own copy of them.
    expect(ctx).not.toHaveProperty('settings')
    expect(options).toMatchObject({ prompt: 'build it', clientPromptId: 'client-1' })

    transport.emitSession('new-1', { type: 'session_init', sessionId: 'provider-thread', model: 'm', skills: [] })
    transport.emitSession('new-1', { type: 'user_message', text: 'build it', clientPromptId: 'client-1' })
    expect(controller.run.agentSessionId).toBe('provider-thread')
    // The host's echo confirms the optimistic row; it does not add another.
    expect(texts(controller)).toEqual(['user:build it'])
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'sent' })
  })

  test('the first prompt carries the provider and model selected on the draft', async () => {
    const api = baseApi().on('prompt', () => ({ disposition: 'started' }))
    const { controller } = await open({ api, target: { hostId: 'inst-a', newSession: {
      sessionId: 'draft', provider: 'codex', workingDirectory: '/work/app',
    } } })
    await controller.load()
    controller.pickProvider('claude-code')
    expect(controller.updateRun({ model: 'claude-sonnet-5-5' })).toBe(true)
    await controller.send('build it')
    const [ctx] = api.callsOf('prompt')[0] as [IpcContext]
    expect(ctx.session).toMatchObject({ provider: 'claude-code', preferredModel: 'claude-sonnet-5-5' })
    controller.close()
  })

  test('Stop becomes available when the host takes the first prompt, including during setup', async () => {
    const reply = Promise.withResolvers<{ disposition: 'started' }>()
    const api = baseApi().on('prompt', () => reply.promise)
    const { controller, transport, changes } = await open({ api, target: { hostId: 'inst-a', newSession: {
      sessionId: 'draft', provider: 'codex', workingDirectory: '/work/app',
    } } })
    await controller.load()
    const send = controller.send('build it')
    await flushPromises()
    expect(api.callsOf('prompt')).toHaveLength(1)
    expect(controller.model.status).toBe('connecting')
    expect(controller.canStopTurn).toBe(false)

    changes.length = 0
    transport.emit('session.executionChanged', { sessionId: 'draft', execution: {
      revision: 1, current: { runId: 'run-1', phase: 'connecting', startedAt: 1 }, lastTurn: null,
    } })
    expect(controller.canStopTurn).toBe(true)
    expect(changes.some((change) => change.meta)).toBe(true)

    reply.resolve({ disposition: 'started' })
    await send
    transport.emit('session.executionChanged', { sessionId: 'draft', execution: {
      revision: 2, current: null,
      lastTurn: { runId: 'run-1', outcome: 'completed', startedAt: 1, endedAt: 2 },
    } })
    expect(controller.canStopTurn).toBe(false)
    controller.close()
  })

  test('a legacy host can enable Stop with a status event that confirms local connecting', async () => {
    const { controller, transport, changes } = await open({ api: baseApi() })
    await controller.load()
    await controller.send('go')
    expect(controller.canStopTurn).toBe(false)

    changes.length = 0
    transport.emitSession('thread-1', { type: 'status_change', status: 'connecting' })
    expect(controller.canStopTurn).toBe(true)
    expect(changes.some((change) => change.meta)).toBe(true)
    transport.emitSession('thread-1', { type: 'status_change', status: 'idle' })
    expect(controller.canStopTurn).toBe(false)
    controller.close()
  })

  test('a new session that a prompt started reloads its history after a reconnect that lost the server session', async () => {
    const api = baseApi()
    const { controller, transport } = await open({ api, target: { hostId: 'inst-a', newSession: { sessionId: 'new-1', provider: 'claude-code', workingDirectory: '/work/app' } } })
    await controller.load()
    await controller.send('build it')
    expect(api.callsOf('loadSessionPage')).toHaveLength(0)

    api.on('loadSessionPage', () => page([userRow('build it', 'm1'), assistantRow('built', 'm2')]))
    await transport.accept(false)
    await flushPromises()
    expect(api.callsOf('describeSession')[0]).toEqual(['new-1'])
    expect(api.callsOf('loadSessionPage')[0]?.[0]).toMatchObject({ sessionId: 'new-1', projectPath: '/work/app' })
    expect(texts(controller)).toEqual(['user:build it', 'assistant:built'])
  })

  test('a send lost with the transport goes again with the same id, once, when the host is back', async () => {
    let fail = true
    const api = baseApi().on('prompt', () => {
      if (fail) throw new TransportDisconnectedError()
      return { disposition: 'started' }
    })
    const { controller, transport, outbox } = await open({ api })
    await controller.load()
    await controller.send('ship it')
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'queued' })
    expect(outbox.entriesFor('inst-a/thread-1')).toHaveLength(1)

    fail = false
    await transport.accept(true)
    await flushPromises()
    await transport.accept(true)
    await flushPromises()
    const ids = api.callsOf('prompt').map((call) => (call[1] as PromptOptions).clientPromptId)
    expect(ids).toEqual(['client-1', 'client-1'])
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'sent' })
    expect(outbox.entriesFor('inst-a/thread-1')).toEqual([])
  })

  test('a refused send is parked for the person; retry sends the same id', async () => {
    let refuse = true
    const api = baseApi().on('prompt', () => {
      if (refuse) throw new Error('This session is read-only.')
      return { disposition: 'started' }
    })
    const { controller } = await open({ api })
    await controller.load()
    await controller.send('ship it')
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'failed', error: 'This session is read-only.' })
    expect(controller.model.status).toBe('idle')

    refuse = false
    await controller.retry('client-1')
    expect(api.callsOf('prompt').map((call) => (call[1] as PromptOptions).clientPromptId)).toEqual(['client-1', 'client-1'])
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'sent' })
  })

  // The host makes a prompt's sender a watcher before the run can publish, so a
  // send that must still watch does not wait for the watch reply (as desktop's promptTab).
  test('a send that must watch sends the prompt before the watch answers, then applies the watch', async () => {
    let watchFails = true
    let answerWatch: (result: object) => void = () => {}
    const api = baseApi().on('watchSession', () => {
      if (watchFails) throw new TransportDisconnectedError()
      return new Promise((resolve) => { answerWatch = resolve })
    })
    const { controller } = await open({ api })
    await controller.load()
    expect(controller.phase.kind).toBe('error')

    watchFails = false
    await controller.send('ship it')
    expect(conversationCalls(api).slice(-2)).toEqual(['watchSession', 'prompt'])
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'sent' })

    answerWatch({
      pendingQuestions: [{ questionId: 'q1', questions: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: false }] }],
      runtime: { status: 'running', modelConfig: { modelId: 'claude-opus-4-5', reasoningEffort: 'high' }, permissionMode: 'plan', queuedPrompts: [], rateLimitInfo: null },
    })
    await flushPromises()
    expect(controller.run.preferredModel).toBe('claude-opus-4-5')
    expect(controller.run.permissionMode).toBe('plan')
    expect(controller.model.status).toBe('running')
    expect(controller.model.questions.map((question) => question.questionId)).toEqual(['q1'])

    // The watch is in place: the next send does not watch again.
    await controller.send('and this')
    expect(api.callsOf('watchSession')).toHaveLength(2)
  })

  test('a watch reply that live events passed is not applied over them', async () => {
    let watchFails = true
    let answerWatch: (result: object) => void = () => {}
    const api = baseApi().on('watchSession', () => {
      if (watchFails) throw new TransportDisconnectedError()
      return new Promise((resolve) => { answerWatch = resolve })
    })
    const { controller, transport } = await open({ api })
    await controller.load()
    watchFails = false
    await controller.send('ship it')
    transport.emitSession('thread-1', { type: 'status_change', status: 'running' })
    answerWatch({ runtime: null })
    await flushPromises()
    expect(controller.model.status).toBe('running')
  })

  test('a failed watch beside a send neither blocks nor fails the prompt, and the next send watches again', async () => {
    let watchFails = true
    const api = baseApi().on('watchSession', () => {
      if (watchFails) throw new Error('watch refused')
      return { runtime: null }
    })
    const { controller } = await open({ api })
    await controller.load()
    await controller.send('ship it')
    await flushPromises()
    expect(api.callsOf('prompt')).toHaveLength(1)
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'sent' })

    watchFails = false
    await controller.send('again')
    expect(api.callsOf('watchSession')).toHaveLength(3)
  })

  test('an unconfirmed prompt stays visible across an app restart', async () => {
    const api = baseApi().on('prompt', () => { throw new TransportDisconnectedError() })
    const first = await open({ api })
    await first.controller.load()
    await first.controller.send('remember me')
    const restarted = new ConversationController({ hostId: 'inst-a', record: record() }, {
      connection: first.connection,
      outbox: first.outbox,
      runSettings: async () => ({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} }),
      organizationId: () => null,
      uuid: () => 'unused',
      onChange: () => {},
    })
    await restarted.load()
    expect(texts(restarted)).toContain('user:remember me')
  })
})

describe('native conversation: requests and plans', () => {
  const planEvent: WireNormalizedEvent = {
    type: 'plan', planContent: '# Add login\n\nSteps', planFilePath: '/p.md', questionId: 'q-plan',
    options: [{ id: 'yes', label: 'Approve', kind: 'allow' }, { id: 'no', label: 'Keep planning', kind: 'deny' }], planToolUseId: 'tool-7',
  }

  test('a permission answered on another client leaves this one', async () => {
    const { controller, transport } = await open({ api: baseApi() })
    await controller.load()
    transport.emitSession('thread-1', { type: 'permission_request', questionId: 'q1', toolName: 'Bash', options: [{ id: 'allow', label: 'Allow' }] })
    expect(controller.model.permissions.map((request) => request.questionId)).toEqual(['q1'])
    transport.emitSession('thread-1', { type: 'permission_resolved', questionId: 'q1', decision: 'approved' })
    expect(controller.model.permissions).toEqual([])
  })

  test('a reader the session is shared with to view may not drive it, so its cards and Stop give way to a note', async () => {
    // WHY: the host refuses a viewer's answer (`respondPermission` needs `drive`); the phone must not offer it.
    const viewer = await open({ api: baseApi(), target: { hostId: 'inst-a', record: { ...record(), role: 'viewer' } } })
    expect(viewer.controller.mayDrive).toBe(false)
    const commenter = await open({ api: baseApi(), target: { hostId: 'inst-a', record: { ...record(), role: 'commenter' } } })
    expect(commenter.controller.mayDrive).toBe(false)
    const editor = await open({ api: baseApi(), target: { hostId: 'inst-a', record: { ...record(), role: 'editor' } } })
    expect(editor.controller.mayDrive).toBe(true)
    // A record from a host that sent no role, and a new session, are the reader's own; the host still decides.
    expect((await open({ api: baseApi() })).controller.mayDrive).toBe(true)
  })

  test('an answer this client may not give says so', async () => {
    const api = baseApi().on('respondQuestion', () => false)
    const { controller, transport } = await open({ api })
    await controller.load()
    transport.emitSession('thread-1', { type: 'question_request', questionId: 'q2', questions: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: false }] })
    expect(await controller.answerQuestion('q2', { 'Which?': 'A' })).toBe(false)
    expect(api.callsOf('respondQuestion')[0]?.slice(1)).toEqual(['thread-1', 'q2', { 'Which?': 'A' }])
    expect(texts(controller).at(-1)).toBe("notice:You can't answer this request.")
  })

  test('feedback on a Claude request goes with its denial, over the same answer call', async () => {
    const api = baseApi().on('respondPermission', () => true)
    const { controller, transport } = await open({ api })
    await controller.load()
    transport.emitSession('thread-1', { type: 'permission_request', questionId: 'q4', toolName: 'Bash', options: [{ id: 'deny', label: 'Deny', kind: 'deny' }], supportsFeedback: true })
    // WHY: the card must offer the composer's text only where the provider takes it.
    expect(controller.model.permissions[0]?.supportsFeedback).toBe(true)
    expect(await controller.answerPermission('q4', 'deny', 'Run it in a safer manner.')).toBe(true)
    expect(api.callsOf('respondPermission')[0]?.slice(1)).toEqual(['thread-1', 'q4', 'deny', undefined, 'Run it in a safer manner.'])
    expect(api.callsOf('prompt')).toEqual([])
  })

  test('an answer to a request the host closed shows the card closed and says why', async () => {
    const api = baseApi().on('respondPermission', () => { throw new HostRpcError('This request can no longer be answered.', REQUEST_NOT_ANSWERABLE_CODE) })
    const { controller, transport } = await open({ api })
    await controller.load()
    transport.emitSession('thread-1', { type: 'permission_request', questionId: 'q3', toolName: 'Bash', options: [{ id: 'allow', label: 'Allow' }] })
    expect(await controller.answerPermission('q3', 'allow')).toBe(false)
    expect(controller.model.permissions).toEqual([expect.objectContaining({ questionId: 'q3', expired: 'closed' })])
    expect(texts(controller).at(-1)).toBe(`notice:${requestExpiryText('closed')}`)
  })

  test('a plan decided on another client shows that decision', async () => {
    const { controller, transport } = await open({ api: baseApi() })
    await controller.load()
    transport.emitSession('thread-1', planEvent)
    expect(controller.model.pendingPlan()?.planId).toBe('thread-1__tool-7')
    transport.emitSession('thread-1', { type: 'permission_resolved', questionId: 'q-plan', decision: 'denied' })
    expect(controller.model.pendingPlan()).toBeNull()
  })

  test('approving a plan starts the implementation the way desktop does', async () => {
    const api = baseApi().on('acceptPlan', () => ({}))
    const { controller, transport } = await open({ api })
    await controller.load()
    transport.emitSession('thread-1', planEvent)
    const plan = controller.model.pendingPlan()!
    expect(await controller.approvePlan(plan)).toBe(true)

    expect(api.callsOf('acceptPlan')[0]?.[1]).toEqual({ planId: 'thread-1__tool-7', startNewSession: true })
    const [ctx, options] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(options.prompt).toBe('Implement this plan: [Add login](plan://ref?planId=thread-1__tool-7&sessionId=thread-1&planToolUseId=tool-7&status=accepted)')
    // A fresh provider thread, in the host's default mode (a plan mode would only plan again).
    expect(ctx.session.agentSessionId).toBeNull()
    expect(ctx.session.permissionMode).toBe('auto')
    expect(controller.model.items.get(plan.id)).toMatchObject({ decision: 'accepted' })
  })

  test('a refused approval keeps the plan pending and sends nothing', async () => {
    const api = baseApi().on('acceptPlan', () => { throw new Error('not allowed') })
    const { controller, transport } = await open({ api })
    await controller.load()
    transport.emitSession('thread-1', planEvent)
    expect(await controller.approvePlan(controller.model.pendingPlan()!)).toBe(false)
    expect(controller.model.pendingPlan()).not.toBeNull()
    expect(api.callsOf('prompt')).toEqual([])
  })

  test('requesting changes to a live plan denies it, then steers the note in plan mode', async () => {
    const api = baseApi().on('respondPermission', () => true)
    const { controller, transport } = await open({ api })
    await controller.load()
    transport.emitSession('thread-1', { type: 'status_change', status: 'awaiting_plan', oldStatus: 'running' })
    transport.emitSession('thread-1', planEvent)
    expect(await controller.requestPlanChanges(controller.model.pendingPlan()!, 'Use OAuth.')).toBe(true)
    expect(api.callsOf('respondPermission')[0]?.slice(1)).toEqual(['thread-1', 'q-plan', 'no'])
    const [ctx, options] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(options.prompt).toBe('Please revise the plan with these comments:\n\nUse OAuth.')
    expect(ctx.session.permissionMode).toBe('plan')
  })
})

describe('native saved artifacts', () => {
  const artifactPage = () => page([
    { role: 'tool', toolId: 'render', toolName: 'render_artifact', toolInput: '{"html_path":"/tmp/render.html"}', content: '', timestamp: 1 },
    { role: 'tool_result', toolResultForId: 'render', status: 'ok', content: '', artifactWorkRef: { workId: 'w', title: 'Chart', contentVersion: 2, layout: { height: 640, heights: [[375, 640]] } }, timestamp: 2 },
  ])
  const artifacts = (model: TranscriptModel) =>
    [...model.items.values()].filter((item) => item.kind === 'artifact')

  test('a saved render names its version and frame, and the phone reads no HTML for it', async () => {
    // WHY: the feed sizes the row from this frame before the page loads, and
    // the page itself comes from the host. A body read here is a second loader.
    const api = baseApi().on('loadSessionPage', artifactPage)
    const { controller } = await open({ api })
    await controller.load()
    expect(artifacts(controller.model)).toEqual([expect.objectContaining({ workId: 'w', title: 'Chart', contentVersion: 2, layout: { height: 640, heights: [[375, 640]] } })])
    expect(api.callsOf('loadWork')).toHaveLength(0)
    expect(api.callsOf('loadSessionToolInputs')).toHaveLength(0)
    controller.close()
  })

  test('live renders and updates name the version they saved', () => {
    const model = new TranscriptModel('s')
    model.apply({ type: 'artifact_created', kind: 'html', html: '<p>one</p>', workId: 'w', title: 'Chart', contentVersion: 1, layout: { height: 300 } })
    model.apply({ type: 'work_updated', workId: 'w', title: 'Chart', docType: 'artifact', content: '<p>two</p>', updatedAt: '2026-11-25T00:00:01Z', contentVersion: 2 })
    // An update that names no version cannot name a page, so it adds no render.
    model.apply({ type: 'work_updated', workId: 'w', title: 'Chart', docType: 'artifact', content: '<p>three</p>', updatedAt: '2026-11-25T00:00:02Z' })
    expect(artifacts(model).map((item) => item.kind === 'artifact' && [item.contentVersion, item.layout?.height])).toEqual([[1, 300], [2, undefined]])
    expect(artifactHtmlRender(artifacts(model)[1] as ArtifactRender)).toEqual({ attachmentId: 'artifact:w:2', title: 'Chart', height: UNMEASURED_REPLY_HEIGHT })
  })
})

test('a task-bound native session prepares its task before dispatch and leaves the local link to the server', async () => {
  const task = { id: 'github:I_1', title: 'Fix login' }
  const api = baseApi().on('tasksPrepareForSession', () => ({ task, snapshot: null }))
  const { controller } = await open({ api, target: { hostId: 'inst-a', newSession: { sessionId: 'new-task-session', provider: 'codex', workingDirectory: '/work/app' } } })
  controller.bindTask(task.id, 'inst-a')
  await controller.load()
  await controller.send('Fix this issue')
  const methods = api.calls.map((call) => call.method)
  expect(methods.indexOf('tasksPrepareForSession')).toBeLessThan(methods.indexOf('prompt'))
  expect(api.callsOf('tasksPrepareForSession')[0]).toEqual([{ taskId: task.id, includeSnapshot: false }])
  expect(api.callsOf('prompt')[0]?.[1]).toMatchObject({ taskId: task.id, prompt: 'Fix this issue' })
  expect(api.callsOf('tasksLinkSession')).toHaveLength(0)
})

test('a refused task preparation keeps the native prompt for retry and never starts an unbound agent', async () => {
  const api = baseApi().on('tasksPrepareForSession', () => { throw new Error('Task access ended') })
  const { controller, outbox } = await open({ api, target: { hostId: 'inst-a', newSession: { sessionId: 'new-task-session', provider: 'codex', workingDirectory: '/work/app' } } })
  controller.bindTask('github:I_1', 'inst-a')
  await controller.load()
  await controller.send('Fix this issue')
  expect(api.callsOf('prompt')).toHaveLength(0)
  expect(outbox.entriesFor('inst-a/new-task-session')[0]?.lastError).toBe('Task access ended')
})


test('a recent conversation keeps its live watch through replay and is evicted on a reset', async () => {
  const api = baseApi().on('configGet', () => ({}))
  let transport!: FakeTransport
  const app = new SolusApp({
    storage: memoryKeyValueStore(), secrets: memorySecretStore(),
    fetch: healthFetch({ 'http://a:1': 'inst-a' }), uuid: () => crypto.randomUUID(),
    createTransport: options => (transport = new FakeTransport(options, api)),
    openBrowser: async () => {}, deviceLabel: 'Test phone',
  })
  try {
    await app.load()
    await app.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
    app.connections.connection('inst-a')
    await transport.accept()
    const readySession = async (sessionId: string) => {
      const store = app.conversation('inst-a', { record: { ...record(), sessionId } })!
      if (store.controller.phase.kind === 'loading') await new Promise<void>(resolve => {
        const stop = store.meta.subscribe(() => {
          if (store.controller.phase.kind !== 'loading') { stop(); resolve() }
        })
      })
      return store
    }
    const store = await readySession('thread-1')
    const release = app.observeConversation(store)
    expect(store.controller.phase.kind).toBe('ready')
    release()
    await transport.accept(true)
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'while away' })
    const opened = app.conversation('inst-a', { record: record() })!
    const releaseAgain = app.observeConversation(opened)
    expect(opened).toBe(store)
    expect(texts(store.controller)).toContain('assistant:while away')
    expect(api.callsOf('loadSessionPage')).toHaveLength(1)
    expect(api.callsOf('watchSession')).toHaveLength(1)
    expect(api.callsOf('unwatchSession')).toHaveLength(0)
    releaseAgain()
    await transport.accept(false)
    expect(app.openConversation('inst-a', 'thread-1')).toBeNull()
    expect(api.callsOf('loadSessionPage')).toHaveLength(1)
    for (const sessionId of ['thread-1', 'two', 'three', 'four']) {
      const store = await readySession(sessionId)
      const leave = app.observeConversation(store)
      leave()
    }
    expect(app.openConversation('inst-a', 'thread-1')).toBeNull()
    expect(app.openConversation('inst-a', 'two')).not.toBeNull()
    transport.emit('share.changed', { resource: { kind: 'session', id: 'two' }, removedUserIds: [] })
    expect(app.openConversation('inst-a', 'two')).toBeNull()
    expect(await app.sessionCache.forHost('inst-a').history('two')).toBeNull()
    app.releaseRecentConversations()
    expect(app.openConversation('inst-a', 'three')).toBeNull()
    expect(app.openConversation('inst-a', 'four')).toBeNull()
  } finally { app.dispose() }
})

test('opening a running turn consumes the overlapping watch replay once and preserves the live tail', async () => {
  const api = baseApi().on('loadSessionPage', () => page([
    userRow('check', 'u'), assistantRow('Reading files', 'a'),
    { role: 'tool', content: '', toolId: 'call', toolName: 'Read', messageId: 't' },
  ]))
  const { controller, transport } = await open({ api })
  api.on('watchSession', () => {
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'Reading ' })
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'files' })
    transport.emitSession('thread-1', { type: 'tool_call', toolId: 'call', toolName: 'Read', index: 0 })
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'New reply' })
    return { runtime: null }
  })
  await controller.load()
  expect(texts(controller)).toEqual(['user:check', 'assistant:Reading files', 'tool', 'assistant:New reply'])
  controller.close()
})

test('the watch RPC can answer before its replay reaches the socket', async () => {
  const api = baseApi().on('loadSessionPage', () => page([
    userRow('check', 'u'), assistantRow('Reading', 'a'),
    { role: 'tool', content: '', toolId: 'call', toolName: 'Read', messageId: 't' },
  ])).on('watchSession', () => ({ runtime: { status: 'running', modelConfig: null, permissionMode: null, queuedPrompts: [], rateLimitInfo: null } }))
  const { controller, transport } = await open({ api })
  await controller.load()
  transport.emitSession('thread-1', { type: 'text_chunk', text: 'Reading' })
  transport.emitSession('thread-1', { type: 'tool_call', toolId: 'call', toolName: 'Read', index: 0 })
  transport.emitSession('thread-1', { type: 'pending_input_sync', pendingInputEvents: [] })
  transport.emitSession('thread-1', { type: 'text_chunk', text: 'After replay' })
  expect(texts(controller)).toEqual(['user:check', 'assistant:Reading', 'tool', 'assistant:After replay'])
  controller.close()
})

test('a reset resumes a confirmed live turn without replacing its rows or fetching history', async () => {
  const api = baseApi()
  const { controller, transport } = await open({ api })
  await controller.load()
  const model = controller.model
  transport.emit('session.eventReceived', { sessionId: 'thread-1', cursor: 'epoch.1', event: { type: 'text_chunk', text: 'first' } })
  api.on('watchSession', () => {
    transport.emit('session.eventReceived', { sessionId: 'thread-1', cursor: 'epoch.2', event: { type: 'text_chunk', text: ' second' } })
    return { resumed: true }
  })
  await transport.accept(false)
  await flushPromises()
  expect(api.callsOf('watchSession').at(-1)?.[0]).toMatchObject({ afterEvent: 'epoch.1' })
  expect(api.callsOf('loadSessionPage')).toHaveLength(1)
  expect(controller.model).toBe(model)
  expect(texts(controller).at(-1)).toBe('assistant:first second')
  api.on('watchSession', () => ({ resumed: true }))
  await transport.accept(false)
  await flushPromises()
  expect(api.callsOf('watchSession').at(-1)?.[0]).toMatchObject({ afterEvent: 'epoch.2' })
  expect(api.callsOf('loadSessionPage')).toHaveLength(1)
  transport.emit('session.eventReceived', { sessionId: 'thread-1', cursor: 'epoch.3', event: { type: 'text_chunk', text: ' third' } })
  api.on('watchSession', () => ({ resumed: false }))
  await transport.accept(false)
  await flushPromises()
  expect(api.callsOf('loadSessionPage')).toHaveLength(2)
  expect(controller.model).not.toBe(model)
  controller.close()
})

test('a draft reuses uploaded files on the same host and only carries device files across hosts', async () => {
  const image = { id: 'image', name: 'photo.png', kind: 'image' as const, mimeType: 'image/png', hostPath: '/host/photo', size: 12, dataUrl: null, localUri: 'file:///picked.png' }
  const { controller } = await open({ api: baseApi(), target: { hostId: 'inst-a', newSession: { sessionId: 'draft', provider: 'codex', workingDirectory: '/repo', attachments: [image] } } })
  expect(controller.filesForDraftCheckout('inst-a')).toEqual({ uploaded: [image], picked: [] })
  expect(controller.filesForDraftCheckout('inst-b')).toEqual({ uploaded: [], picked: [{ name: image.name, mimeType: image.mimeType, size: image.size, uri: image.localUri }] })
  controller.attachments = [{ ...image, localUri: undefined }]
  expect(() => controller.filesForDraftCheckout('inst-b')).toThrow('only copy')
  expect(controller.attachments[0]?.id).toBe('image')
  controller.close()
})
