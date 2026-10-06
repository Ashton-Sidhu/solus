import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { AgentId, IpcContext, NormalizedEvent } from '@solus/contracts/types'
import { asHostApi } from '@solus/client-core/host-api'
import type { SlashCommandRunContext } from '@solus/workspace-ui/components/input/slash-commands'
let commands: typeof import('@solus/workspace-ui/components/input/slash-commands')
import { conversationContext, DEFAULT_RUN_SETTINGS } from '../../apps/mobile/src/features/conversation/lib/ipc-context'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
// Commands do not need the mounted Svelte workspace or its sign-in stores.
mock.module('../../packages/workspace-ui/src/contexts/index.ts', () => ({ agentAuthStore: {}, seatsStore: {}, seatProviderOf: () => null }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
let SessionRuntime: typeof import('@solus/server/execution/session-runtime')['SessionRuntime']
let SolusServer: typeof import('@solus/server/transport/server')['SolusServer']
let registerSessionHandlers: typeof import('@solus/server/transport/handlers/session-handlers')['registerSessionHandlers']
beforeAll(async () => {
  commands = await import('@solus/workspace-ui/components/input/slash-commands')
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
  ;({ SessionRuntime } = await import('@solus/server/execution/session-runtime'))
  ;({ SolusServer } = await import('@solus/server/transport/server'))
  ;({ registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers'))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let nextSession = 0
function context(provider: AgentId = 'codex', thread = true): IpcContext {
  const number = ++nextSession
  return conversationContext({
    sessionId: `compact-session-${number}`, agentSessionId: thread ? `compact-thread-${number}` : null,
    provider, status: 'idle', workingDirectory: '/tmp', preferredModel: null,
    reasoningEffort: 'high', contextWindow: null, fastMode: false,
    permissionMode: 'supervised', title: null, organizationId: null,
  }, DEFAULT_RUN_SETTINGS, {})
}

class Client {
  shutdown(): void {}
  requests: Array<{ method: string; params: { threadId: string; turnId?: string } }> = []
  resume = deferred<{ thread: { id: string }; model: string }>()
  compactStarted = deferred<void>()
  failure: Error | null = null
  async request(method: string, params: { threadId: string; turnId?: string }) {
    this.requests.push({ method, params })
    if (this.failure) throw this.failure
    if (method === 'thread/resume') return this.resume.promise
    if (method === 'thread/compact/start') this.compactStarted.resolve()
    return {}
  }
}

interface Notification {
  method: string
  params: {
    threadId: string
    turnId?: string
    turn?: { id: string; status: string; items: never[] }
    item?: { id: string; type: 'contextCompaction' }
  }
}

const runtimes: Array<InstanceType<typeof SessionRuntime>> = []
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.shutdown() })

function setup(ctx: IpcContext) {
  const backend = new CodexBackend()
  const client = new Client()
  // SAFETY: Replace only the app-server transport; all run and event logic remains real.
  const internals = backend as unknown as { client: Client; onNotification(message: Notification, client: Client): void }
  internals.client = client
  const runtime = new SessionRuntime(new Map([['codex', backend]]))
  runtimes.push(runtime)
  const server = new SolusServer()
  registerSessionHandlers(server, {
    sessionRuntime: runtime, agentIdFromContext: (input) => input?.session.provider ?? 'codex',
    orchestrator: { mayAnswer: () => true },
  })
  const notify = (message: Notification) => internals.onNotification(message, client)
  const turn = (status: string) => ({ threadId: ctx.session.agentSessionId!, turn: { id: 'compact-turn', status, items: [] } })
  const events: NormalizedEvent[] = []
  const errors: string[] = []
  runtime.on('error', (_sessionId, error) => errors.push(error.message))
  runtime.on('event', (_sessionId, event) => events.push(event))
  return { backend, client, runtime, server, notify, turn, events, errors }
}

async function start(ctx: IpcContext, fixture: ReturnType<typeof setup>) {
  await fixture.server.handle('compactSession', [ctx], TEST_HANDLER_CTX)
  fixture.client.resume.resolve({ thread: { id: ctx.session.agentSessionId! }, model: 'gpt-test' })
  await fixture.client.compactStarted.promise
}

describe('Codex /compact server path', () => {
  test('requests the addressed thread without a model prompt, then delivers compaction events and settles status', async () => {
    // WHY: Manual compaction must use the app-server operation and the existing transcript path.
    const ctx = context()
    const fixture = setup(ctx)
    await start(ctx, fixture)
    expect(fixture.client.requests).toEqual([
      { method: 'thread/resume', params: { threadId: ctx.session.agentSessionId! } },
      { method: 'thread/compact/start', params: { threadId: ctx.session.agentSessionId! } },
    ])
    expect(fixture.runtime.statuses.liveSessionStatus(ctx.session.agentSessionId!)).toBe('running')
    fixture.notify({ method: 'turn/started', params: fixture.turn('inProgress') })
    const params = { threadId: ctx.session.agentSessionId!, turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' as const } }
    fixture.notify({ method: 'item/started', params })
    fixture.notify({ method: 'item/completed', params })
    const handle = fixture.backend.getSessionHandle(ctx.session.agentSessionId!)!
    fixture.notify({ method: 'turn/completed', params: fixture.turn('completed') })
    await handle.runPromise
    expect(fixture.events.filter((event) => event.type === 'context_compaction')).toEqual([
      { type: 'context_compaction', state: 'start' }, { type: 'context_compaction', state: 'stop' },
    ])
    expect(fixture.events.some((event) => event.type === 'user_message' || event.type === 'text_chunk')).toBe(false)
    expect(fixture.backend.isSessionRunning(ctx.session.agentSessionId!)).toBe(false)
    expect(fixture.runtime.statuses.hasActiveWork()).toBe(false)
  })

  test('a provider startup failure clears busy state and permits another attempt', async () => {
    const ctx = context()
    const fixture = setup(ctx)
    fixture.client.failure = new Error('Codex is unavailable')
    await fixture.server.handle('compactSession', [ctx], TEST_HANDLER_CTX)
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.errors).toEqual(['Codex is unavailable'])
    expect(fixture.runtime.statuses.hasActiveWork()).toBe(false)
    expect(fixture.backend.getPendingHandles()).toEqual([])
    fixture.client.failure = null
    await start(ctx, fixture)
    const handle = fixture.backend.getSessionHandle(ctx.session.agentSessionId!)!
    fixture.notify({ method: 'turn/completed', params: fixture.turn('completed') })
    await handle.runPromise
  })

  test.each(['connecting', 'running', 'awaiting_input'] as const)('refuses a %s session without a provider request', async (status) => {
    const ctx = context()
    const fixture = setup(ctx)
    fixture.runtime.activeSessions.set(ctx.session.sessionId, {
      sessionId: ctx.session.sessionId, agentSessionId: ctx.session.agentSessionId,
      backendId: 'codex', status, pendingInputEvents: [], lastActivityAt: Date.now(), promptCount: 1,
    })
    await expect(fixture.server.handle('compactSession', [ctx], TEST_HANDLER_CTX)).rejects.toThrow('Wait for the current turn to finish')
    expect(fixture.client.requests).toEqual([])
  })

  test('refuses a draft, a fork draft, and another provider without starting work', async () => {
    for (const ctx of [context('codex', false), context('claude-code'), context()]) {
      if (ctx.session.provider === 'codex' && ctx.session.agentSessionId) ctx.session.forked = true
      const fixture = setup(ctx)
      await expect(fixture.server.handle('compactSession', [ctx], TEST_HANDLER_CTX)).rejects.toThrow(
        ctx.session.provider === 'codex' ? 'Send a first message' : 'only supported for Codex',
      )
      expect(fixture.client.requests).toEqual([])
      expect(fixture.runtime.statuses.hasActiveWork()).toBe(false)
    }
  })

  test('reserves the session while seat and thread startup are pending', async () => {
    const ctx = context()
    const fixture = setup(ctx)
    await fixture.server.handle('compactSession', [ctx], TEST_HANDLER_CTX)
    await expect(fixture.server.handle('compactSession', [ctx], TEST_HANDLER_CTX)).rejects.toThrow('Wait for the current turn')
    expect(fixture.client.requests).toHaveLength(1)
    expect(fixture.runtime.stopSession(ctx.session.sessionId, TEST_HANDLER_CTX.actor)).toBe(true)
    fixture.client.resume.resolve({ thread: { id: ctx.session.agentSessionId! }, model: 'gpt-test' })
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.client.requests.some((call) => call.method === 'thread/compact/start')).toBe(false)
    expect(fixture.runtime.statuses.hasActiveWork()).toBe(false)
  })

  test('a stopped seat lookup cannot clear a newer compaction on the same session', async () => {
    // WHY: Stop can release setup while a credential lookup is still in flight.
    const ctx = context()
    const fixture = setup(ctx)
    const oldSeat = deferred<null>()
    const lookupStarted = deferred<void>()
    let lookups = 0
    fixture.runtime.seatForTurn = async () => {
      lookups++
      if (lookups === 1) {
        lookupStarted.resolve()
        return oldSeat.promise
      }
      return null
    }
    const oldRequest = fixture.server.handle('compactSession', [ctx], TEST_HANDLER_CTX)
    await lookupStarted.promise
    expect(fixture.runtime.stopSession(ctx.session.sessionId, TEST_HANDLER_CTX.actor)).toBe(true)
    await start(ctx, fixture)
    oldSeat.resolve(null)
    await expect(oldRequest).rejects.toThrow('Interrupted')
    expect(fixture.runtime.statuses.liveSessionStatus(ctx.session.agentSessionId!)).toBe('running')
    const handle = fixture.backend.getSessionHandle(ctx.session.agentSessionId!)!
    fixture.notify({ method: 'turn/completed', params: fixture.turn('completed') })
    await handle.runPromise
  })

  test.each([false, true])('Stop interrupts compaction when turn/started arrives %s after Stop', async (stopBeforeTurn) => {
    // WHY: compact/start returns no turn id. A Stop must survive that event gap.
    const ctx = context()
    const fixture = setup(ctx)
    await start(ctx, fixture)
    const handle = fixture.backend.getSessionHandle(ctx.session.agentSessionId!)!
    if (!stopBeforeTurn) fixture.notify({ method: 'turn/started', params: fixture.turn('inProgress') })
    expect(await fixture.backend.steerSession(ctx.session.agentSessionId!, { prompt: 'follow-up' })).toBeNull()
    expect(fixture.runtime.stopSession(ctx.session.sessionId, TEST_HANDLER_CTX.actor)).toBe(true)
    if (stopBeforeTurn) fixture.notify({ method: 'turn/started', params: fixture.turn('inProgress') })
    expect(fixture.client.requests.at(-1)).toEqual({
      method: 'turn/interrupt', params: { threadId: ctx.session.agentSessionId!, turnId: 'compact-turn' },
    })
    fixture.notify({ method: 'item/completed', params: { threadId: ctx.session.agentSessionId!, turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } } })
    fixture.notify({ method: 'turn/completed', params: fixture.turn('interrupted') })
    await handle.runPromise
    expect(fixture.events.some((event) => event.type === 'context_compaction' && event.state === 'stop')).toBe(false)
    expect(fixture.backend.isSessionRunning(ctx.session.agentSessionId!)).toBe(false)
    expect(fixture.runtime.statuses.hasActiveWork()).toBe(false)
  })
})

describe('Codex /compact command', () => {
  test('runs only for Codex, restores focus, and shows a draft or host refusal message', async () => {
    const command = commands.CODEX_SLASH_COMMANDS.find((entry) => entry.command === '/compact')!
    expect(commands.codexSlashCommands('claude-code', true)).toEqual([])
    expect(commands.slashCommandAppliesTo(command, 'codex')).toBe(true)
    expect(commands.slashCommandAppliesTo(command, 'claude-code')).toBe(false)
    const messages: string[] = []
    let calls = 0
    let focus = 0
    const ctx: SlashCommandRunContext = {
      api: asHostApi({ compactSession: async () => { calls++; throw new Error('Wait for the current turn to finish.') } }),
      argument: '', ipcContext: context(), sessionId: null, provider: 'codex',
      clearCurrentConversation: () => {}, appendGlobalInstructions: () => {},
      addSystemMessage: (text) => messages.push(text), requestInputFocus: () => { focus++ },
    }
    await command.run!(ctx)
    expect(calls).toBe(0)
    expect(messages[0]).toContain('Send a first message')
    ctx.sessionId = ctx.ipcContext.session.sessionId
    await command.run!(ctx)
    expect(calls).toBe(1)
    expect(messages[1]).toContain('Wait for the current turn')
    expect(focus).toBe(2)
  })
})
