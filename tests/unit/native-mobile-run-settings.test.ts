import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { AgentMetadata, IpcContext, PromptOptions, WatchSessionInput } from '@solus/contracts/types'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import { ConversationController, type ConversationTarget } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { DEFAULT_RUN_SETTINGS, type RunSettings } from '../../apps/mobile/src/features/conversation/lib/ipc-context'
import { canChoosePermissionMode, canRouteAuto, modelChoices, offersPlanToggle, PERMISSION_MODE_ICON, rememberedFastMode, newSessionModel, permissionModesFor, savedSessionModel, selectModel, supportedPermissionMode, supportsFastMode } from '../../apps/mobile/src/features/conversation/lib/run-settings'
import { KeyboardCommands } from '../../apps/mobile/src/features/keyboard/keyboard-commands'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, healthFetch } from './helpers/native-mobile-fakes'

describe('native run settings', () => {
  test('a saved Claude session resumes with the window it ran at, never none', () => {
    expect(savedSessionModel('claude-code', 'claude-opus-5-5[1m]', null)).toEqual({ preferredModel: 'claude-opus-5-5', reasoningEffort: 'medium', contextWindow: 1_000_000, fastMode: false })
    expect(savedSessionModel('codex', 'gpt-6-astra', 'high')).toEqual({ preferredModel: 'gpt-6-astra', reasoningEffort: 'high', contextWindow: 1_050_000, fastMode: false })
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

async function controllerFor(target: ConversationTarget, settings: RunSettings, status: 'idle' | 'running' = 'idle', host: (api: FakeApi) => void = () => {}) {
  const api = new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => ({ messages: [], before: null }))
    .on('watchSession', (input: WatchSessionInput) => ({
      sessionId: input.sessionId ?? 's',
      runtime: status === 'running' ? { status: 'running', modelConfig: null, permissionMode: null, queuedPrompts: [], rateLimitInfo: null } : null,
    }))
    .on('prompt', () => ({ disposition: 'started' }))
  host(api)
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
  await controller.runOptionsLoaded
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

describe('native mode and model capability', () => {
  const agent = (id: AgentMetadata['id'], capabilities: AgentMetadata['capabilities']): AgentMetadata => ({ id, label: id, models: [], defaultModel: '', capabilities })
  const hostWith = (agents: AgentMetadata[], typeSafeSource: 'saved' | null = 'saved') => (api: FakeApi) => api
    .on('start', () => ({ version: '1', projectPath: '/w', homePath: '/h', agents }))
    // SAFETY: the controller reads only `typeSafe.source` from the snapshot.
    .on('configGet', () => ({ typeSafe: { source: typeSafeSource } } as unknown as HostConfigSnapshot))
  const newCodex = { hostId: 'inst-a', newSession: { sessionId: 'n', provider: 'codex' as const, workingDirectory: '/w' } }

  test('Plan is offered only where the agent has plan mode; unknown hosts keep it', () => {
    expect(permissionModesFor({ planMode: false })).toEqual(['supervised', 'accept-edits', 'auto', 'full-access'])
    expect(permissionModesFor(undefined)).toContain('plan')
    expect(canChoosePermissionMode({ permissions: false })).toBe(false)
    expect(canChoosePermissionMode(undefined)).toBe(true)
    // The draft composer's Plan shortcut follows the same rule.
    expect(offersPlanToggle({ planMode: false })).toBe(false)
    expect(offersPlanToggle({ permissions: false })).toBe(false)
    expect(offersPlanToggle(undefined)).toBe(true)
  })

  test('a mode the agent lacks falls back to the run default, never to Plan', () => {
    expect(supportedPermissionMode('plan', { planMode: false }, 'accept-edits')).toBe('accept-edits')
    expect(supportedPermissionMode('plan', { planMode: false }, 'plan')).toBe('full-access')
    expect(supportedPermissionMode('plan', { planMode: true }, 'supervised')).toBe('plan')
  })

  test('a stale Plan from defaults or a pick is dropped once the host says the agent has no plan mode', async () => {
    const { api, controller } = await controllerFor(newCodex, { ...DEFAULT_RUN_SETTINGS, defaultPermissionMode: 'plan' }, 'idle', hostWith([agent('codex', { planMode: false })]))
    expect(controller.run.permissionMode).toBe('full-access')
    controller.updateRun({ permissionMode: 'plan' })
    await controller.send('go')
    const [ctx] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(ctx.session.permissionMode).toBe('full-access')
  })

  test('Auto is a choice only before the host starts the session', () => {
    expect(canRouteAuto({ started: false, agentSessionId: null })).toBe(true)
    expect(canRouteAuto({ started: true, agentSessionId: null })).toBe(false)
    expect(canRouteAuto({ started: false, agentSessionId: 'p' })).toBe(false)
  })

  test('Auto goes to the host for a new session, and falls back when the host has no TypeSafe key', async () => {
    const keyed = await controllerFor(newCodex, DEFAULT_RUN_SETTINGS, 'idle', hostWith([]))
    expect(keyed.controller.canRoute).toBe(true)
    keyed.controller.updateRun({ model: 'auto' })
    await keyed.controller.send('go')
    const [ctx] = keyed.api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(ctx.session.preferredModel).toBe('auto')

    const unkeyed = await controllerFor(newCodex, { ...DEFAULT_RUN_SETTINGS, defaultModels: { codex: 'auto' } }, 'idle', hostWith([], null))
    expect(unkeyed.controller.autoNeedsKey).toBe(true)
    expect(unkeyed.controller.run.preferredModel).toBe('gpt-6-astra')
  })

  test('fast mode rides with a Codex model that has it, and clears on one without', async () => {
    expect(supportsFastMode('codex', 'gpt-5.5')).toBe(true)
    expect(supportsFastMode('codex', 'gpt-5.3-codex')).toBe(false)
    expect(supportsFastMode('codex', 'auto')).toBe(false)
    expect(supportsFastMode('claude-code', 'claude-opus-5-5')).toBe(false)

    const { api, controller, savedOptions } = await controllerFor(newCodex, DEFAULT_RUN_SETTINGS, 'idle', hostWith([]))
    controller.updateRun({ model: 'gpt-5.5', fastMode: true })
    await controller.send('go')
    const [ctx] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(ctx.session.fastMode).toBe(true)
    expect(ctx.statusBar.fastMode).toBe(true)
    expect(savedOptions.at(-1)?.[2]).toMatchObject({ fastMode: true })
    controller.updateRun({ model: 'gpt-5.3-codex' })
    expect(controller.run.fastMode).toBe(false)
  })
})

describe('native reopened session fast mode', () => {
  const codexRecord = { hostId: 'inst-a', record: { sessionId: 't', provider: 'codex' as const, projectPath: '/w', cwd: '/w', model: 'gpt-5.5', reasoningEffort: 'high' as const, title: null, customTitle: null } }
  const fastSaved = (fastMode: boolean): RunSettings => ({ ...DEFAULT_RUN_SETTINGS, modelOptionsByProvider: { codex: { 'gpt-5.5': { reasoningEffort: 'high', contextWindow: null, fastMode } } } })

  test('the person\'s synced choice for the model is the only durable source, and only for a model with fast mode', () => {
    expect(rememberedFastMode('codex', 'gpt-5.5', fastSaved(true))).toBe(true)
    expect(rememberedFastMode('codex', 'gpt-5.5', fastSaved(false))).toBe(false)
    expect(rememberedFastMode('codex', 'gpt-5.3-codex', { ...DEFAULT_RUN_SETTINGS, modelOptionsByProvider: { codex: { 'gpt-5.3-codex': { reasoningEffort: 'high', contextWindow: null, fastMode: true } } } })).toBe(false)
  })

  test('an idle reopened Codex session keeps the fast mode the person chose, and sends it', async () => {
    const { api, controller } = await controllerFor(codexRecord, fastSaved(true))
    expect(controller.run.fastMode).toBe(true)
    await controller.send('go')
    const [ctx] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(ctx.session.fastMode).toBe(true)
  })

  test('a live run\'s own fast mode wins over the remembered one', async () => {
    const api = (fake: FakeApi) => fake.on('watchSession', (input: WatchSessionInput) => ({
      sessionId: input.sessionId ?? 't',
      runtime: { status: 'running', modelConfig: { modelId: 'gpt-5.5', reasoningEffort: 'high', contextWindow: null, fastMode: false }, permissionMode: null, queuedPrompts: [], rateLimitInfo: null },
    }))
    const { controller } = await controllerFor(codexRecord, fastSaved(true), 'idle', api)
    expect(controller.run.fastMode).toBe(false)
  })
})

describe('native permission mode icons', () => {
  test('each mode wears the desktop icon\'s native twin, read from the desktop mapping', () => {
    // WHY: the phone and desktop must show one mark per mode (lock, open lock...).
    // The desktop names a Lucide icon; this is its SF Symbol / Tabler twin.
    const nativeTwin = { Lock: 'lock', FilePenLine: 'square.and.pencil', Sparkles: 'sparkles', LockOpen: 'lock.open', ListTodo: 'checklist' } as const
    const desktop = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/lib/permission-modes.ts'), 'utf8')
    for (const mode of Object.keys(PERMISSION_MODE_ICON) as Array<keyof typeof PERMISSION_MODE_ICON>) {
      const lucide = new RegExp(`'?${mode}'?: \\{[^}]*icon: (\\w+)`).exec(desktop)?.[1] as keyof typeof nativeTwin | undefined
      expect({ mode, icon: PERMISSION_MODE_ICON[mode] }).toEqual({ mode, icon: nativeTwin[lucide!] })
    }
  })
})
