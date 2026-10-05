import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { AgentConversationUpdate, IpcContext, WatchSessionInput } from '@solus/contracts/types'
import { ConversationController } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { DEFAULT_RUN_SETTINGS } from '../../apps/mobile/src/features/conversation/lib/ipc-context'
import { AgentPlans } from '../../apps/mobile/src/features/conversation/lib/agent-plans'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, healthFetch } from './helpers/native-mobile-fakes'

const dispatched = (agentSessionId: string, messageId: string): AgentConversationUpdate => ({
  phase: 'dispatched', agentSessionId, messageId, origin: 'created', prompt: 'Plan the login', provider: 'claude-code', title: 'Login work', cwd: '/w', dispatchedAt: 1,
})
const heldPlan = (agentSessionId: string, messageId: string): AgentConversationUpdate => ({
  phase: 'awaiting_input', agentSessionId, messageId,
  request: { kind: 'plan', plan: { questionId: 'q', planToolUseId: 't', title: 'Add login', content: '# Add login', blocking: true } },
})

describe('plans of another session', () => {
  test('a held-open plan waits with its text until the target answers it, here or elsewhere', () => {
    const plans = new AgentPlans()
    plans.apply(dispatched('child', 'm1'))
    plans.apply(heldPlan('child', 'm1'))
    expect(plans.awaiting()).toEqual([{ targetSessionId: 'child', messageId: 'm1', sessionTitle: 'Login work', planTitle: 'Add login', content: '# Add login' }])
    plans.apply({ phase: 'answered', agentSessionId: 'child', messageId: 'm1', answerText: 'Approved the plan' })
    expect(plans.awaiting()).toEqual([])
  })

  test('a finished turn with a plan waits by name; new work or a stop ends the wait', () => {
    const plans = new AgentPlans()
    plans.apply(dispatched('child', 'm1'))
    plans.apply({ phase: 'settled', agentSessionId: 'child', messageId: 'm1', status: 'completed', replyText: 'Done', outputs: [{ kind: 'plan', sessionId: 'child', planToolUseId: 't', title: 'Add login' }], settledAt: 2 })
    expect(plans.awaiting()).toMatchObject([{ planTitle: 'Add login', content: null }])
    plans.apply(dispatched('child', 'm2'))
    expect(plans.awaiting()).toEqual([])

    const stopped = new AgentPlans()
    stopped.apply(dispatched('other', 'm1'))
    stopped.apply({ phase: 'settled', agentSessionId: 'other', messageId: 'm1', status: 'completed', replyText: '', outputs: [{ kind: 'plan', sessionId: 'other', planToolUseId: 't', title: 'P' }], settledAt: 2 })
    stopped.apply({ phase: 'stopped', agentSessionId: 'other' })
    expect(stopped.awaiting()).toEqual([])
  })

  test('a card opened before its session existed follows the session it becomes', () => {
    const plans = new AgentPlans()
    plans.apply(dispatched('pending:m1', 'm1'))
    plans.apply({ phase: 'attached', agentSessionId: 'child', messageId: 'm1' })
    plans.apply(heldPlan('child', 'm1'))
    expect(plans.awaiting().map((plan) => plan.targetSessionId)).toEqual(['child'])
  })
})

describe('deciding another session\'s plan', () => {
  async function conversation(decided: boolean) {
    const api = new FakeApi()
      .on('describeSession', () => ({ lineage: null, meta: null }))
      .on('loadSessionPage', () => ({ messages: [], before: null }))
      .on('watchSession', (input: WatchSessionInput) => ({ sessionId: input.sessionId! }))
      .on('decideSessionPlan', () => decided)
    const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
    await world.registry.load()
    await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 't')
    const connection = world.connections.connection('inst-a')!
    const transport = world.transports[0]!
    await transport.accept()
    const storage = memoryKeyValueStore()
    const controller = new ConversationController({ hostId: 'inst-a', record: { sessionId: 'lead', provider: 'claude-code', projectPath: '/w', cwd: '/w', model: null, reasoningEffort: null, title: null, customTitle: null } }, {
      executionPreferences: () => ({}),
      connection, outbox: new SendOutbox(() => storage), runSettings: async () => DEFAULT_RUN_SETTINGS, organizationId: () => null, uuid: () => 'u', onChange: () => {},
    })
    await controller.load()
    transport.emitSession('lead', { type: 'agent_conversation_update', update: dispatched('child', 'm1') })
    transport.emitSession('lead', { type: 'agent_conversation_update', update: heldPlan('child', 'm1') })
    return { api, controller }
  }

  test('asking for changes acts on the target session and the card leaves', async () => {
    const { api, controller } = await conversation(true)
    const [plan] = controller.model.agentPlans.awaiting()
    expect(await controller.decideAgentPlan(plan!, 'request_changes', '  Use OAuth.  ')).toBe(true)
    const [ctx, target, decision, comment] = api.callsOf('decideSessionPlan')[0] as [IpcContext, string, string, string]
    expect([ctx.session.sessionId, target, decision, comment]).toEqual(['lead', 'child', 'request_changes', 'Use OAuth.'])
    expect(controller.model.agentPlans.awaiting()).toEqual([])
  })

  test('a plan already decided elsewhere is refused and says so', async () => {
    const { controller } = await conversation(false)
    const [plan] = controller.model.agentPlans.awaiting()
    expect(await controller.decideAgentPlan(plan!, 'approve')).toBe(false)
    expect(controller.model.agentPlans.awaiting()).toHaveLength(1)
    const last = controller.model.items.get(controller.model.order.at(-1)!)
    expect(last).toMatchObject({ kind: 'notice', text: 'This plan is no longer waiting on a decision.' })
  })
})
