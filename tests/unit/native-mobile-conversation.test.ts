import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import { HostRpcError, TransportDisconnectedError } from '@solus/client-core/rpc-error'
import { REQUEST_NOT_ANSWERABLE_CODE, requestExpiryText } from '@solus/contracts/types'
import type { IpcContext, PromptOptions, WatchSessionInput, WireNormalizedEvent } from '@solus/contracts/types'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { ConversationController, type ConversationTarget } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, flushPromises, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'

const page = (messages: SessionHistoryPage['messages'], before: string | null = null): SessionHistoryPage => ({ messages, before })
const userRow = (content: string, messageId: string) => ({ role: 'user', content, messageId, timestamp: 1 })
const assistantRow = (content: string, messageId: string) => ({ role: 'assistant', content, messageId, timestamp: 2 })

function record(provider: 'claude-code' | 'codex' = 'claude-code'): NonNullable<ConversationTarget['record']> {
  return { sessionId: 'thread-1', provider, projectPath: '/work/app', cwd: '/work/app', model: null, reasoningEffort: null, title: 'Fix it', customTitle: null }
}

interface Setup {
  api: FakeApi
  target?: ConversationTarget
}

async function open(setup: Setup) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => setup.api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
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
    outbox,
    runSettings: async () => ({ defaultPermissionMode: 'auto' }),
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
    .on('watchSession', (input: WatchSessionInput) => ({ sessionId: input.sessionId ?? 'solus-1', runtime: null }))
    .on('unwatchSession', () => undefined)
    .on('prompt', () => ({ disposition: 'started' }))
}

/** The conversation's own calls, without the per-connection capability and agent reads
 *  and the run-option read beside history. */
const conversationCalls = (api: FakeApi) => api.calls.map((call) => call.method)
  .filter((method) => method !== 'serverGetCapabilities' && method !== 'start' && method !== 'configGet')

const texts = (controller: ConversationController) => controller.model.order.map((id) => {
  const item = controller.model.items.get(id)
  return item && 'text' in item ? `${item.kind}:${item.text}` : item?.kind
})

describe('native conversation: history and live events', () => {
  test('loads history before joining the live stream and holds events that arrive meanwhile', async () => {
    let releasePage!: (value: SessionHistoryPage) => void
    const api = baseApi().on('loadSessionPage', () => new Promise<SessionHistoryPage>((resolve) => { releasePage = resolve }))
    const { controller, transport } = await open({ api })
    const loading = controller.load()
    await flushPromises()
    expect(conversationCalls(api)).toEqual(['describeSession', 'loadSessionPage'])

    // An event for this session while history is in flight is held, not applied.
    transport.emitSession('thread-1', { type: 'text_chunk', text: 'later' })
    expect(controller.model.order).toEqual([])

    releasePage(page([userRow('hello', 'm1')]))
    await loading
    expect(conversationCalls(api)).toEqual(['describeSession', 'loadSessionPage', 'watchSession'])
    expect(api.callsOf('watchSession')[0]?.[0]).toEqual({ sessionId: 'thread-1', agentSessionId: 'thread-1', provider: 'claude-code', attachRuntime: true })
    expect(texts(controller)).toEqual(['user:hello', 'assistant:later'])
    expect(controller.phase).toEqual({ kind: 'ready' })
  })

  test('adopts the id the host answers with and streams into one assistant row', async () => {
    const api = baseApi().on('watchSession', () => ({ sessionId: 'solus-9', runtime: { status: 'running', modelConfig: null, permissionMode: null, queuedPrompts: [], rateLimitInfo: null } }))
    const { controller, transport, changes } = await open({ api })
    await controller.load()
    expect(controller.run.sessionId).toBe('solus-9')
    expect(controller.model.status).toBe('running')

    transport.emitSession('thread-1', { type: 'text_chunk', text: 'ignored: old id' })
    changes.length = 0
    transport.emitSession('solus-9', { type: 'text_chunk', text: 'Hel' })
    transport.emitSession('solus-9', { type: 'text_chunk', text: 'lo' })
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

  test('opens a Codex session with its own provider on every call', async () => {
    const api = baseApi()
    const { controller } = await open({ api, target: { hostId: 'inst-a', record: record('codex') } })
    await controller.load()
    expect(api.callsOf('describeSession')[0]).toEqual(['codex', 'thread-1'])
    expect(api.callsOf('loadSessionPage')[0]?.[0]).toMatchObject({ provider: 'codex' })
    expect(api.callsOf('watchSession')[0]?.[0]).toMatchObject({ provider: 'codex' })
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
      .on('watchSession', (input: WatchSessionInput) => ({ sessionId: input.sessionId! }))
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

  test('an unconfirmed prompt stays visible across an app restart', async () => {
    const api = baseApi().on('prompt', () => { throw new TransportDisconnectedError() })
    const first = await open({ api })
    await first.controller.load()
    await first.controller.send('remember me')
    const restarted = new ConversationController({ hostId: 'inst-a', record: record() }, {
      executionPreferences: () => ({}),
      connection: first.connection,
      outbox: first.outbox,
      runSettings: async () => ({ defaultPermissionMode: 'auto' }),
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

  test('an answer this client may not give says so', async () => {
    const api = baseApi().on('respondQuestion', () => false)
    const { controller, transport } = await open({ api })
    await controller.load()
    transport.emitSession('thread-1', { type: 'question_request', questionId: 'q2', questions: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: false }] })
    expect(await controller.answerQuestion('q2', { 'Which?': 'A' })).toBe(false)
    expect(api.callsOf('respondQuestion')[0]?.slice(1)).toEqual(['thread-1', 'q2', { 'Which?': 'A' }])
    expect(texts(controller).at(-1)).toBe("notice:You can't answer this request.")
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
