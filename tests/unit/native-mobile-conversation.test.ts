import { describe, expect, test } from 'bun:test'
import { MobileSessionCache } from '../../apps/mobile/solus-core/features/threads/session-cache'
import { PullRequestCache, memoryPullRequestCacheDatabase } from '@solus/client-core/pull-request-cache'
import { INITIAL_HISTORY_TURNS, prefetchSessionHistoryPage } from '@solus/client-core/session-history-page'
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

const page = (messages: SessionHistoryPage['messages'], before: string | null = null): SessionHistoryPage => ({ messages, before })
const userRow = (content: string, messageId: string) => ({ role: 'user', content, messageId, timestamp: 1 })
const assistantRow = (content: string, messageId: string) => ({ role: 'assistant', content, messageId, timestamp: 2 })

function record(provider: 'claude-code' | 'codex' = 'claude-code'): NonNullable<ConversationTarget['record']> {
  return { sessionId: 'thread-1', provider, projectPath: '/work/app', cwd: '/work/app', model: null, reasoningEffort: null, title: 'Fix it', customTitle: null }
}

interface Setup {
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
    executionPreferences: () => ({ extraInstructions: 'Be brief.' }),
    connection,
    sessionCache: setup.sessionCache,
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
 *  read beside history, and the reads of the session's suggestions and background records. */
// The host's policy is a shared host fact (plans/030 §7), read once per host, not a call of this conversation.
const conversationCalls = (api: FakeApi) => api.calls.map((call) => call.method).filter((method) => method !== 'hostPolicy')
  .filter((method) => method !== 'serverGetCapabilities' && method !== 'connectionsGetServerInfo' && method !== 'start' && method !== 'configGet' && method !== 'setSessionReadState' && method !== 'sessionSuggestions' && method !== 'mcpTaskList' && method !== 'integrationResourceWatchList' && method !== 'typeSafeKeyStatus')

const texts = (controller: ConversationController) => controller.model.order.map((id) => {
  const item = controller.model.items.get(id)
  return item && 'text' in item ? `${item.kind}:${item.text}` : item?.kind
})

describe('native conversation: history and live events', () => {
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

  test('a completed navigation prefetch paints immediately while the session description is still pending', async () => {
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account').forHost('inst-a')
    const description = Promise.withResolvers<null>()
    const api = baseApi().on('describeSession', () => description.promise)
    const { controller, connection } = await open({ api, sessionCache: cache })
    await prefetchSessionHistoryPage(connection.api, { ...controller.historySource, turnLimit: INITIAL_HISTORY_TURNS, deferArtifactHtml: true }, 3_000, cache.historyScope(connection.state.sessionGeneration))
    const loading = controller.load()
    expect(texts(controller)).toEqual(['user:hello', 'assistant:hi there'])
    const painted = controller.model
    description.resolve(null)
    await loading
    expect(controller.model).toBe(painted)
    expect(api.callsOf('loadSessionPage')).toHaveLength(1)
    expect((await cache.history('thread-1'))?.messages).toHaveLength(2)
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
    expect((await cache.history('thread-1'))?.messages).toHaveLength(2)
    controller.close()
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
    expect(conversationCalls(api)).toEqual(['loadSessionPage', 'describeSession'])

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
    expect(ctx.settings.executionPreferences.extraInstructions).toBe('Be brief.')
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
      executionPreferences: () => ({}),
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

describe('native saved artifact bodies', () => {
  const artifactPage = () => page([
    { role: 'tool', toolId: 'render', toolName: 'render_artifact', toolInput: '{"html_path":"/tmp/render.html"}', content: '', timestamp: 1 },
    { role: 'tool_result', toolResultForId: 'render', status: 'ok', content: '', artifactWorkRef: { workId: 'w', title: 'Chart', contentVersion: 2 }, timestamp: 2 },
  ])
  test('a deferred render reads its original HTML if the saved work version is gone', async () => {
    const rows = artifactPage()
    rows.messages[0] = { ...rows.messages[0]!, toolInput: '{}', toolInputKey: 'a'.repeat(64) }
    const api = baseApi().on('loadSessionPage', () => rows)
      .on('loadWork', () => null).on('loadWorkRevisions', () => [])
      .on('loadSessionToolInputs', () => [{ key: 'a'.repeat(64), toolInput: JSON.stringify({ html: '<p>Original</p>' }) }])
    const { controller } = await open({ api })
    await controller.load()
    const id = controller.model.order.find(id => controller.model.items.get(id)?.kind === 'artifact')!
    expect(api.callsOf('loadSessionToolInputs')).toHaveLength(0)
    await controller.ensureArtifact(id)
    expect(controller.model.items.get(id)).toMatchObject({ html: '<p>Original</p>' })
    controller.close()
  })
  test('an old card reads its saved revision, with one request shared by mounted readers', async () => {
    const api = baseApi().on('loadSessionPage', artifactPage)
      .on('loadWork', () => ({ id: 'w', content: 'latest', contentVersion: 3 }))
      .on('loadWorkRevisions', () => [{ revisionId: 9, sourceContentVersion: 2 }])
      .on('loadWorkRevision', () => ({ content: '<p>Version 2</p>' }))
    const { controller } = await open({ api })
    await controller.load()
    const id = controller.model.order.find((id) => controller.model.items.get(id)?.kind === 'artifact')!
    await Promise.all([controller.ensureArtifact(id), controller.ensureArtifact(id)])
    expect(controller.model.items.get(id)).toMatchObject({ html: '<p>Version 2</p>', contentVersion: 2 })
    expect(api.callsOf('loadWorkRevision')).toHaveLength(1)
    expect(api.callsOf('loadWorkRevision')[0]).toEqual(['w', 9])
  })
  test('a slow read from before reconnect cannot replace the rebuilt card', async () => {
    let release!: (work: { content: string; contentVersion: number }) => void
    const api = baseApi().on('loadSessionPage', artifactPage)
      .on('loadWork', () => new Promise((resolve) => { release = resolve }))
    const { controller } = await open({ api })
    await controller.load()
    const id = controller.model.order.find((id) => controller.model.items.get(id)?.kind === 'artifact')!
    const old = controller.ensureArtifact(id)
    await controller.load()
    api.on('loadWork', () => ({ content: '<p>Saved version</p>', contentVersion: 2 }))
    await controller.ensureArtifact(id)
    release({ content: '<p>Stale reply</p>', contentVersion: 2 })
    await old
    expect(controller.model.items.get(id)).toMatchObject({ html: '<p>Saved version</p>' })
  })
  test('a card asked for during a reload still reads into the rebuilt transcript', async () => {
    // WHY: a read shared across the rebuild would answer the old transcript only,
    // and the new card would wait forever.
    let releasePage!: () => void
    let pageRequested!: () => void
    const reloadAsksForPage = new Promise<void>((resolve) => { pageRequested = resolve })
    const api = baseApi().on('loadSessionPage', artifactPage)
      .on('loadWork', () => new Promise(() => {}))
    const { controller } = await open({ api })
    await controller.load()
    const id = controller.model.order.find((id) => controller.model.items.get(id)?.kind === 'artifact')!
    void controller.ensureArtifact(id)
    api.on('loadSessionPage', () => new Promise((resolve) => {
      releasePage = () => resolve(artifactPage())
      pageRequested()
    }))
    const reloading = controller.load()
    await reloadAsksForPage
    void controller.ensureArtifact(id)
    releasePage()
    await reloading
    api.on('loadWork', () => ({ content: '<p>Saved version</p>', contentVersion: 2 }))
    await controller.ensureArtifact(id)
    expect(controller.model.items.get(id)).toMatchObject({ html: '<p>Saved version</p>' })
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
