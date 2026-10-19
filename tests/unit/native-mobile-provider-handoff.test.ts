import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { Activity } from '@solus/contracts/activity'
import type { IpcContext } from '@solus/contracts/types'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import { ConversationController, type ConversationTarget } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { handoffDividerText, isHandoffPending } from '../../apps/mobile/src/features/conversation/lib/provider-handoff'
import { deriveThreadFeedPresentation, type FeedSourceEntry } from '../../apps/mobile/src/features/threads/thread-feed-presentation'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'

/**
 * Plan 021 on mobile: a provider pick is composer state. The host hands the
 * session off only when a prompt carries another provider, and the transcript
 * says so: a pending row before the send, the handoff divider after it.
 */

const page = (messages: SessionHistoryPage['messages']): SessionHistoryPage => ({ messages, before: null })

function agentSwitched(id: string, extra: Partial<Extract<Activity, { kind: 'agent_switched' }>> = {}): Extract<Activity, { kind: 'agent_switched' }> {
  return { id, subject: { kind: 'session', id: 'thread-1' }, at: 5, by: { kind: 'system' }, kind: 'agent_switched', provider: 'codex', fromProvider: 'claude-code', ...extra }
}

function baseApi(): FakeApi {
  return new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => page([{ role: 'user', content: 'hello', messageId: 'm1', timestamp: 1 }]))
    .on('watchSession', () => ({ runtime: null }))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => Date.now())
    .on('prompt', () => ({ disposition: 'started' }))
}

async function open(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection('inst-a')!
  const transport = world.transports[0] as FakeTransport
  await transport.accept()
  const outboxStorage = memoryKeyValueStore()
  let nextId = 0
  const target: ConversationTarget = { hostId: 'inst-a', record: { sessionId: 'thread-1', provider: 'claude-code', projectPath: '/work/app', cwd: '/work/app', model: null, reasoningEffort: null, title: 'Fix it', customTitle: null } }
  const controller = new ConversationController(target, {
    executionPreferences: () => ({}),
    connection,
    outbox: new SendOutbox(() => outboxStorage),
    runSettings: async () => ({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} }),
    organizationId: () => null,
    uuid: () => `client-${++nextId}`,
    onChange: () => undefined,
  })
  await controller.load()
  return { controller, transport }
}

const kinds = (controller: ConversationController) => controller.model.order.map((id) => controller.model.items.get(id)?.kind)

describe('provider handoff rules', () => {
  test('a handoff is pending only when a thread exists and the pick is another provider', () => {
    expect(isHandoffPending('claude-code', 'codex')).toBe(true)
    expect(isHandoffPending('claude-code', 'claude-code')).toBe(false)
    // A session no prompt started has no thread to hand off: a pick just picks.
    expect(isHandoffPending(null, 'codex')).toBe(false)
  })

  test('the divider reads `from → to` when both models are known, else the agent it continued with', () => {
    expect(handoffDividerText({ provider: 'codex', model: 'gpt-6-astra', fromProvider: 'claude-code', fromModel: 'claude-opus-5-5' })).toBe('Opus 5.5 → Gpt 6 Astra')
    expect(handoffDividerText({ provider: 'codex', fromProvider: 'claude-code' })).toBe('Continued with Codex')
  })

  test('the pending row ends the feed, after the live slot', () => {
    const entries: FeedSourceEntry[] = [{ id: 'u1', kind: 'user' }, { id: 'a1', kind: 'assistant' }]
    const rows = deriveThreadFeedPresentation({ entries, turnActive: true, working: true, expandedTurnIds: new Set(), expandedWorkGroupIds: new Set(), handoffPending: true })
    // The reply's image row sits before the live slot; the pending row is still last.
    expect(rows.map((row) => row.type)).toEqual(['message', 'message', 'turn-images', 'thinking', 'handoff-pending'])
  })

  test('a finished turn does not fold a handoff divider away', () => {
    const entries: FeedSourceEntry[] = [{ id: 'u1', kind: 'user' }, { id: 'a1', kind: 'assistant' }, { id: 't1', kind: 'tool' }, { id: 'h1', kind: 'handoff' }, { id: 'a2', kind: 'assistant' }]
    const rows = deriveThreadFeedPresentation({ entries, turnActive: false, working: false, expandedTurnIds: new Set(), expandedWorkGroupIds: new Set() })
    expect(rows.map((row) => row.type)).toContain('handoff')
  })
})

describe('native conversation: provider pick', () => {
  test('a pick and a pick back change only the composer: no host call', async () => {
    const api = baseApi()
    const { controller } = await open(api)
    const callsBefore = api.calls.length
    controller.pickProvider('codex')
    expect(controller.run.provider).toBe('codex')
    expect(controller.threadProvider).toBe('claude-code')
    expect(isHandoffPending(controller.threadProvider, controller.run.provider)).toBe(true)
    controller.pickProvider('claude-code')
    expect(isHandoffPending(controller.threadProvider, controller.run.provider)).toBe(false)
    expect(api.calls.slice(callsBefore)).toEqual([])
    controller.close()
  })

  test('the next prompt carries the picked provider and its model', async () => {
    const api = baseApi()
    const { controller } = await open(api)
    controller.pickProvider('codex')
    const model = controller.run.preferredModel
    await controller.send('go on')
    const ctx = api.callsOf('prompt')[0]?.[0] as IpcContext
    expect(ctx.session.provider).toBe('codex')
    expect(ctx.session.preferredModel).toBe(model)
    expect(api.callsOf('sessionQueueChange')).toHaveLength(0)
    controller.close()
  })

  test('a pick on a rate-limited session keeps the parked prompt card', async () => {
    const rateLimitInfo = { resetsAt: 9, rateLimitType: 'five_hour', prompt: 'parked', queuedPrompt: 'parked' }
    const api = baseApi().on('watchSession', () => ({ runtime: { status: 'rate_limited', modelConfig: null, permissionMode: null, queuedPrompts: [], rateLimitInfo } }))
    const { controller } = await open(api)
    expect(controller.model.rateLimit).not.toBeNull()
    controller.pickProvider('codex')
    expect(controller.model.rateLimit).toEqual(rateLimitInfo)
    controller.close()
  })

  test('the host’s handoff after a send becomes the thread provider and draws its divider before that prompt', async () => {
    const api = baseApi()
    const { controller, transport } = await open(api)
    controller.pickProvider('codex')
    await controller.send('go on')
    transport.emitSession('thread-1', { type: 'activity', activity: agentSwitched('act-1') })
    expect(controller.threadProvider).toBe('codex')
    expect(isHandoffPending(controller.threadProvider, controller.run.provider)).toBe(false)
    expect(kinds(controller)).toEqual(['user', 'handoff', 'user'])
    controller.close()
  })

  test('a handoff another client made moves a composer that had not picked', async () => {
    const api = baseApi()
    const { controller, transport } = await open(api)
    transport.emitSession('thread-1', { type: 'activity', activity: agentSwitched('act-1', { model: 'gpt-6-astra' }) })
    expect(controller.run.provider).toBe('codex')
    expect(controller.run.preferredModel).toBe('gpt-6-astra')
    controller.close()
  })

  test('history draws a recorded handoff as a divider', async () => {
    const api = baseApi().on('loadSessionPage', () => page([
      { role: 'user', content: 'hello', messageId: 'm1', timestamp: 1 },
      { role: 'activity', content: '', timestamp: 2, activity: agentSwitched('act-1') },
      { role: 'user', content: 'go on', messageId: 'm2', timestamp: 3 },
    ]))
    const { controller } = await open(api)
    expect(kinds(controller)).toEqual(['user', 'handoff', 'user'])
    controller.close()
  })
})
