import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { IpcContext, PromptOptions, WatchSessionInput } from '@solus/contracts/types'
import { ConversationController, type ConversationTarget } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { DEFAULT_RUN_SETTINGS, type RunSettings } from '../../apps/mobile/src/features/conversation/lib/ipc-context'
import { modelChoices, newSessionModel, savedSessionModel, selectModel } from '../../apps/mobile/src/features/conversation/lib/run-settings'
import { KeyboardCommands } from '../../apps/mobile/src/features/keyboard/keyboard-commands'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, healthFetch } from './helpers/native-mobile-fakes'

describe('native run settings', () => {
  test('a saved Claude session resumes with the window it ran at, never none', () => {
    expect(savedSessionModel('claude-code', 'claude-opus-5-5[1m]', null)).toEqual({ preferredModel: 'claude-opus-5-5', reasoningEffort: 'medium', contextWindow: 1_000_000 })
    expect(savedSessionModel('codex', 'gpt-6-astra', 'high')).toEqual({ preferredModel: 'gpt-6-astra', reasoningEffort: 'high', contextWindow: 1_050_000 })
  })

  test('a new session starts on the host default model, else the profile default', () => {
    expect(newSessionModel('claude-code', { defaultModels: { 'claude-code': 'claude-haiku-4-5-20251001' }, modelOptionsByProvider: {} }).preferredModel).toBe('claude-haiku-4-5-20251001')
    expect(newSessionModel('codex', null).preferredModel).toBe('gpt-6-astra')
  })

  test('a model keeps the person\'s saved effort only when the model offers it', () => {
    const saved = { defaultModels: {}, modelOptionsByProvider: { 'claude-code': { 'claude-haiku-4-5-20251001': { reasoningEffort: 'max' as const, contextWindow: null, fastMode: false } } } }
    expect(selectModel('claude-code', 'claude-haiku-4-5-20251001', saved).reasoningEffort).toBe('medium')
  })

  test('the picker hides legacy models except the one the session uses', () => {
    const ids = modelChoices('claude-code', 'claude-opus-4-6').map((choice) => choice.id)
    expect(ids).toContain('claude-opus-4-6')
    expect(ids).not.toContain('claude-opus-4-7')
  })
})

async function controllerFor(target: ConversationTarget, settings: RunSettings, status: 'idle' | 'running' = 'idle') {
  const api = new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => ({ messages: [], before: null }))
    .on('watchSession', (input: WatchSessionInput) => ({
      sessionId: input.sessionId ?? 's',
      runtime: status === 'running' ? { status: 'running', modelConfig: null, permissionMode: null, queuedPrompts: [], rateLimitInfo: null } : null,
    }))
    .on('prompt', () => ({ disposition: 'started' }))
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 't')
  const connection = world.connections.connection('inst-a')!
  await world.transports[0]!.accept()
  const storage = memoryKeyValueStore()
  const savedOptions: unknown[][] = []
  const controller = new ConversationController(target, {
    executionPreferences: () => ({}),
    connection,
    outbox: new SendOutbox(() => storage),
    runSettings: async () => settings,
    saveModelOptions: (...args) => { savedOptions.push(args) },
    organizationId: () => null,
    uuid: () => 'id-1',
    onChange: () => {},
  })
  await controller.load()
  return { api, controller, savedOptions }
}

describe('native run settings in a conversation', () => {
  test('a resumed session sends its model window with every prompt', async () => {
    const { api, controller } = await controllerFor({ hostId: 'inst-a', record: { sessionId: 't', provider: 'claude-code', projectPath: '/w', cwd: '/w', model: 'claude-opus-5-5[1m]', reasoningEffort: 'high', title: null, customTitle: null } }, DEFAULT_RUN_SETTINGS)
    await controller.send('go')
    const [ctx] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(ctx.session).toMatchObject({ preferredModel: 'claude-opus-5-5', reasoningEffort: 'high', contextWindow: 1_000_000 })
  })

  test('model and permission changes apply to the next prompt while current work continues', async () => {
    const idle = await controllerFor({ hostId: 'inst-a', newSession: { sessionId: 'n', provider: 'codex', workingDirectory: '/w' } }, { ...DEFAULT_RUN_SETTINGS, defaultPermissionMode: 'supervised' })
    expect(idle.controller.run).toMatchObject({ preferredModel: 'gpt-6-astra', permissionMode: 'supervised' })
    expect(idle.controller.updateRun({ model: 'gpt-6-luna', permissionMode: 'plan' })).toBe(true)
    await idle.controller.send('plan it')
    const [ctx] = idle.api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(ctx.session).toMatchObject({ provider: 'codex', preferredModel: 'gpt-6-luna', permissionMode: 'plan', contextWindow: 1_050_000 })

    const busy = await controllerFor({ hostId: 'inst-a', record: { sessionId: 't', provider: 'claude-code', projectPath: '/w', cwd: '/w', model: null, reasoningEffort: null, title: null, customTitle: null } }, DEFAULT_RUN_SETTINGS, 'running')
    expect(busy.controller.updateRun({ model: 'claude-haiku-4-5-20251001' })).toBe(true)
    expect(busy.controller.updateRun({ permissionMode: 'accept-edits' })).toBe(true)
    expect(busy.controller.run.permissionMode).toBe('accept-edits')
    // The chosen options are the person's (plans/018), kept on this device, never written to the host.
    expect(busy.savedOptions).toEqual([['claude-code', 'claude-haiku-4-5-20251001', { reasoningEffort: busy.controller.run.reasoningEffort, contextWindow: busy.controller.run.contextWindow, fastMode: false }]])
    expect(busy.api.callsOf('configUpdate')).toEqual([])
  })
})

describe('native hardware keyboard commands', () => {
  test('the newest handler answers; one that declines passes the command on', () => {
    const commands = new KeyboardCommands()
    const calls: string[] = []
    const stopBelow = commands.register('stop', () => { calls.push('below') })
    const stopTop = commands.register('stop', () => { calls.push('top'); return false })
    expect(commands.enabledCommands()).toEqual(['stop'])
    expect(commands.dispatch('stop')).toBe(true)
    expect(calls).toEqual(['top', 'below'])
    stopTop()
    stopBelow()
    expect(commands.enabledCommands()).toEqual([])
    expect(commands.dispatch('stop')).toBe(false)
  })
})
