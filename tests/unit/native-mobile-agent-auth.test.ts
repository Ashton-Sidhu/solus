import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import { HOST_LOGIN_SEAT as seat } from '@solus/contracts/seats'
import { ConversationController } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, flushPromises, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'

function api(): FakeApi {
  return new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => ({ messages: [], before: null }))
    .on('watchSession', () => ({ runtime: null }))
    .on('unwatchSession', () => undefined)
    .on('prompt', () => ({ disposition: 'started' }))
    .on('agentAuthStart', () => ({ state: 'waiting', flowId: 'flow-1', url: 'https://mcp.example/authorize', input: 'redirect-url' }))
    .on('agentAuthCancel', () => ({ cancelled: true }))
    .on('agentAuthSignOut', () => ({ message: 'Signed out of linear.' }))
    .on('seatConnectStart', () => ({ verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234', requiresCodeInput: false }))
    .on('seatConnectCancel', () => ({ cancelled: true }))
}

async function open(provider: 'claude-code' | 'codex' = 'claude-code') {
  const fake = api()
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => fake })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection('inst-a')!
  const transport = world.transports[0] as FakeTransport
  await transport.accept()
  let nextId = 0
  const outboxStorage = memoryKeyValueStore()
  const controller = new ConversationController({ hostId: 'inst-a', record: {
    sessionId: 'thread-1', provider, projectPath: '/work/app', cwd: '/work/app', model: null, reasoningEffort: null, title: 'Fix it', customTitle: null,
  } }, {
    executionPreferences: () => ({}),
    connection,
    outbox: new SendOutbox(() => outboxStorage),
    runSettings: async () => ({ defaultPermissionMode: 'auto' }),
    organizationId: () => null,
    uuid: () => `client-${++nextId}`,
    onChange: () => undefined,
  })
  await controller.load()
  return { api: fake, transport, controller }
}

const notices = (controller: ConversationController) => controller.model.order
  .map((id) => controller.model.items.get(id))
  .flatMap((item) => item && item.kind === 'notice' ? [item.text] : [])

describe('native conversation: sign-in commands', () => {
  test('a sign-in command runs on the host and never reaches the agent as a prompt', async () => {
    const { api, controller } = await open()
    await controller.send('/mcp login linear')
    expect(api.callsOf('prompt')).toEqual([])
    expect(api.callsOf('agentAuthStart')).toEqual([[{ kind: 'mcp', provider: 'claude-code', server: 'linear', cwd: '/work/app' }]])
    expect(controller.auth.view).toMatchObject({ step: 'waiting', title: 'Sign in to linear', input: 'redirect-url' })

    // Plain `/mcp` is the agent's own command and still goes to it.
    await controller.send('/mcp')
    expect(api.callsOf('prompt').map(([, options]) => (options as { prompt: string }).prompt)).toEqual(['/mcp'])
  })

  test('only the end of this flow closes it; another flow\'s end is ignored', async () => {
    const { controller, transport } = await open()
    await controller.send('/design-login')
    transport.emit('host.agentAuthFinished', { seat, flowId: 'flow-other', ok: false, message: 'Not yours.' })
    expect(controller.auth.view.step).toBe('waiting')
    transport.emit('host.agentAuthFinished', { seat, flowId: 'flow-1', ok: true, message: 'Signed in to Claude Design.' })
    expect(controller.auth.view).toMatchObject({ step: 'finished', ok: true, message: 'Signed in to Claude Design.' })
  })

  test('/login is the seat connect for the session\'s provider and ends on its seat change', async () => {
    const { api, controller, transport } = await open('codex')
    await controller.send('/login')
    expect(api.callsOf('seatConnectStart')).toEqual([[{ provider: 'codex' }]])
    expect(controller.auth.view).toMatchObject({ step: 'waiting', title: 'Sign in to Codex', userCode: 'ABCD-1234', input: null })
    transport.emit('host.seatChanged', { seat, provider: 'claude-code', state: 'connected' })
    expect(controller.auth.view.step).toBe('waiting')
    transport.emit('host.seatChanged', { seat, provider: 'codex', state: 'none', error: 'The code expired.' })
    expect(controller.auth.view).toMatchObject({ step: 'finished', ok: false, message: 'The code expired.' })
  })

  test('/mcp without a server name asks for one and does not call the host; logout reports the host\'s answer', async () => {
    const { api, controller } = await open()
    await controller.send('/mcp login')
    expect(api.callsOf('agentAuthStart')).toEqual([])
    await controller.send('/mcp logout linear')
    await flushPromises()
    expect(notices(controller)).toEqual(['Name a server: /mcp login <server>', 'Signed out of linear.'])
    expect(controller.auth.view.step).toBe('closed')
  })

  test('cancel stops the flow on the host and closes the sheet', async () => {
    const { api, controller } = await open()
    await controller.send('/mcp login linear')
    await controller.auth.cancel()
    expect(api.callsOf('agentAuthCancel')).toEqual([[{ flowId: 'flow-1' }]])
    expect(controller.auth.view.step).toBe('closed')
  })
})
