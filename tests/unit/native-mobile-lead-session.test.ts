import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { IpcContext, PromptOptions } from '@solus/contracts/types'
import type { LeadModelSelection } from '@solus/contracts/settings'
import { ConversationController, type ConversationTarget } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { LeadSessionChoice } from '../../apps/mobile/src/features/conversation/lib/lead-session'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

/** A lead session (docs/plans/lead-session.md): chosen before the first
 *  prompt, sent with it only, and started on the person's lead model. */

const NEW: ConversationTarget = { hostId: 'inst-a', newSession: { sessionId: 'new-1', provider: 'claude-code', workingDirectory: '/work/app' } }

async function open(target: ConversationTarget = NEW) {
  const api = new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => ({ messages: [], before: null }))
    .on('watchSession', () => ({}))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => Date.now())
    .on('prompt', () => ({ disposition: 'started' }))
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection('inst-a')!
  await (world.transports[0] as FakeTransport).accept()
  const outboxStorage = memoryKeyValueStore()
  let nextId = 0
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
  const prompts = () => api.callsOf('prompt') as Array<[IpcContext, PromptOptions]>
  // As the new-session composer does it.
  const choice = new LeadSessionChoice()
  const setLead = (lead: boolean, leadModel: LeadModelSelection | null) => {
    if (choice.choose(controller.run, lead, leadModel, { defaultModels: {}, modelOptionsByProvider: {} })) controller.updateRun({})
  }
  return { controller, prompts, setLead }
}

describe('native lead session', () => {
  test('isLead goes with the first prompt only', async () => {
    const { controller, prompts, setLead } = await open()
    setLead(true, null)
    await controller.send('coordinate the release')
    await controller.send('and report back')
    expect(prompts().map(([, options]) => options.isLead)).toEqual([true, undefined])
  })

  test('a session that is not a lead sends no isLead', async () => {
    const { controller, prompts } = await open()
    await controller.send('fix it')
    expect(prompts()[0]?.[1].isLead).toBeUndefined()
  })

  test('the lead cannot be chosen once the session has started', async () => {
    const { controller, prompts, setLead } = await open()
    await controller.send('fix it')
    // The host named the provider thread: the session has started.
    controller.run.agentSessionId = 'provider-thread'
    setLead(true, null)
    await controller.send('then lead')
    expect(controller.run.lead).toBeUndefined()
    expect(prompts()[1]?.[1].isLead).toBeUndefined()
  })

  test('a lead starts on the lead model, and turning it off gives back the run it replaced', async () => {
    const { controller, prompts, setLead } = await open()
    const before = { provider: controller.run.provider, model: controller.run.preferredModel }
    setLead(true, { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'low' })
    expect(controller.run).toMatchObject({ provider: 'codex', preferredModel: 'gpt-5.5', reasoningEffort: 'low' })
    setLead(false, { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'low' })
    expect({ provider: controller.run.provider, model: controller.run.preferredModel }).toEqual(before)

    setLead(true, { provider: 'codex', model: 'gpt-5.5' })
    await controller.send('coordinate')
    expect(prompts()[0]?.[0].session).toMatchObject({ provider: 'codex', preferredModel: 'gpt-5.5' })
    expect(prompts()[0]?.[1].isLead).toBe(true)
  })
})
