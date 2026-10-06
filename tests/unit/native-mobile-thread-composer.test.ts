import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import { providerModelsFor, type ProjectEntry, type PromptOptions } from '@solus/contracts/types'
import { ConversationController } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'
import { resolveComposerSendPresentation } from '../../apps/mobile/src/features/threads/composerSendPresentation'
import { connectionFloatingStatus, formatWorkingDuration } from '../../apps/mobile/src/features/threads/floating-working-status'
import {
  buildProviderGroups,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
  providerSectionIsCollapsed,
  agentUnavailableReason,
  autoModelOption,
  permissionModeChoices,
  selectableEffortChoices,
} from '../../apps/mobile/src/features/threads/thread-settings-options'
import { filterProjectScopes, getProjectScopeSelectionTarget, groupProjectScopes, scopeOfProject } from '../../apps/mobile/src/features/threads/new-task-project-selection'
import type { SolusProjectShell } from '../../apps/mobile/src/features/threads/thread-directory'

describe('native composer send button', () => {
  test('an idle thread sends, or queues while the host is away', () => {
    expect(resolveComposerSendPresentation({ running: false, canSteer: false, followUpBehavior: 'steer', deliveryDeferred: false }))
      .toMatchObject({ label: 'Send', icon: 'arrow.up', action: null, offersFollowUpChoice: false })
    expect(resolveComposerSendPresentation({ running: false, canSteer: false, followUpBehavior: 'steer', deliveryDeferred: true }).label).toBe('Queue')
  })

  test('a running turn steers by default and offers queue on long press', () => {
    expect(resolveComposerSendPresentation({ running: true, canSteer: true, followUpBehavior: 'steer', deliveryDeferred: false }))
      .toEqual({ label: 'Steer', icon: 'arrow.turn.left.up', action: 'steer', alternate: 'queue', offersFollowUpChoice: true })
  })

  test('a turn that cannot be steered, or a waiting queue, only queues: no promise the host would break', () => {
    expect(resolveComposerSendPresentation({ running: true, canSteer: false, followUpBehavior: 'steer', deliveryDeferred: false }))
      .toEqual({ label: 'Queue', icon: 'list.number', action: 'queue', alternate: null, offersFollowUpChoice: false })
    expect(resolveComposerSendPresentation({ running: true, canSteer: true, followUpBehavior: 'steer', deliveryDeferred: true }).action).toBe('queue')
  })
})

describe('native floating working pill', () => {
  const onReconnect = () => undefined

  test('a connected host frees the pill for working state; any other phase names the host', () => {
    expect(connectionFloatingStatus({ connectionState: 'connected', hostLabel: 'Studio', onReconnect })).toBeNull()
    expect(connectionFloatingStatus({ connectionState: 'reconnecting', hostLabel: 'Studio', onReconnect })).toMatchObject({ kind: 'connection', tone: 'reconnecting', label: 'Reconnecting to Studio...' })
    expect(connectionFloatingStatus({ connectionState: 'offline', hostLabel: 'Studio', onReconnect })).toMatchObject({ tone: 'unavailable', label: 'Studio is offline' })
    expect(connectionFloatingStatus({ connectionState: null, hostLabel: null, onReconnect })).toMatchObject({ label: 'Host is not connected' })
  })

  test('the working timer reads seconds, then minutes and padded seconds, then hours', () => {
    expect(formatWorkingDuration(0, 12_000)).toBe('12s')
    expect(formatWorkingDuration(0, 184_000)).toBe('3m 04s')
    expect(formatWorkingDuration(0, 3_720_000)).toBe('1h 2m')
    expect(formatWorkingDuration(5_000, 1_000)).toBe('0s')
  })
})

describe('native thread settings sheet', () => {
  test('the permission choices are the Solus permission modes, desktop labels and all', () => {
    const choices = permissionModeChoices(undefined)
    expect(choices.map((choice) => choice.mode)).toEqual(['supervised', 'accept-edits', 'auto', 'full-access', 'plan'])
    expect(choices[0]).toEqual({ mode: 'supervised', label: 'Supervised', description: 'Ask before commands and edits' })
    expect(choices.find((choice) => choice.mode === 'full-access')?.label).toBe('Full access')
  })

  test('another agent is offered only once its host reports it installed, as on desktop', () => {
    const installed = (available: boolean) => [{ id: 'codex' as const, label: 'Codex', models: [], defaultModel: '', available }]
    const reasonFor = (agents: Parameters<typeof agentUnavailableReason>[0]['agents']) =>
      agentUnavailableReason({ provider: 'codex', currentProvider: 'claude-code', agents })
    expect(reasonFor(installed(true))).toBeNull()
    expect(reasonFor(installed(false))).toBe('Not installed')
    expect(reasonFor([])).toBe('Not on this host')
    // Unknown (loading, disconnected, an older host) is never shown as available.
    expect(reasonFor(null)).toBe('Checking availability')
    // The session's own agent keeps its models, whatever the host has said.
    expect(agentUnavailableReason({ provider: 'claude-code', currentProvider: 'claude-code', agents: null })).toBeNull()
    const groups = buildProviderGroups({ currentProvider: 'claude-code', currentModel: null, canSwitchProvider: true, agents: installed(false) })
    expect(groups.map((group) => [group.providerKey, group.unavailableReason])).toEqual([['claude-code', null], ['codex', 'Not installed']])
  })

  test('an agent without plan mode is not offered Plan', () => {
    expect(permissionModeChoices({ planMode: false }).map((choice) => choice.mode)).not.toContain('plan')
  })

  test('Auto is found by name and stays on the session agent until the host routes it', () => {
    const auto = autoModelOption('codex')
    expect(auto).toMatchObject({ provider: 'codex', model: 'auto', label: 'Auto', isDefault: false })
    expect(modelMatchesCatalogQuery({ model: auto, query: 'aut' })).toBe(true)
  })

  test('each agent marks one Default: the model it starts on, not every profile flagged default', () => {
    for (const group of buildProviderGroups({ currentProvider: 'claude-code', currentModel: null, canSwitchProvider: true, agents: null })) {
      const defaults = group.models.filter((model) => model.isDefault)
      expect(defaults.map((model) => model.model)).toEqual([providerModelsFor(group.providerKey).defaultModel])
    }
  })

  test('a session that can switch agents lists both catalogs; one that cannot keeps its own', () => {
    expect(buildProviderGroups({ currentProvider: 'claude-code', currentModel: null, canSwitchProvider: true, agents: null }).map((group) => group.providerKey)).toEqual(['claude-code', 'codex'])
    expect(buildProviderGroups({ currentProvider: 'codex', currentModel: null, canSwitchProvider: false, agents: null }).map((group) => group.providerKey)).toEqual(['codex'])
  })

  test('the session\'s own legacy model is not hidden behind the legacy filter', () => {
    const [claude] = buildProviderGroups({ currentProvider: 'claude-code', currentModel: 'claude-opus-4-6', canSwitchProvider: false, agents: null })
    expect(claude?.models.find((model) => model.model === 'claude-opus-4-6')?.isLegacy).toBe(false)
  })

  test('a staged pick toggles off on the applied model and survives a second tap', () => {
    const [group] = buildProviderGroups({ currentProvider: 'claude-code', currentModel: null, canSwitchProvider: false, agents: null })
    const [first, second] = group!.models
    expect(pendingModelAfterPress({ current: null, pressed: first!, pressedIsApplied: false })).toBe(first!)
    expect(pendingModelAfterPress({ current: first!, pressed: first!, pressedIsApplied: false })).toBe(first!)
    expect(pendingModelAfterPress({ current: first!, pressed: second!, pressedIsApplied: true })).toBeNull()
  })

  test('search matches what the person can read, and narrowing opens every section', () => {
    const [group] = buildProviderGroups({ currentProvider: 'codex', currentModel: null, canSwitchProvider: false, agents: null })
    const model = group!.models[0]!
    expect(modelMatchesCatalogQuery({ model, query: model.label.toUpperCase() })).toBe(true)
    expect(modelMatchesCatalogQuery({ model, query: 'no such model' })).toBe(false)
    expect(providerSectionIsCollapsed({ defaultExpanded: true, hasExpansionOverride: true, isNarrowed: true })).toBe(false)
    expect(providerSectionIsCollapsed({ defaultExpanded: true, hasExpansionOverride: true, isNarrowed: false })).toBe(true)
  })

  test('workflow triggers are not offered as reasoning levels', () => {
    for (const group of buildProviderGroups({ currentProvider: 'claude-code', currentModel: null, canSwitchProvider: true, agents: null })) {
      for (const model of group.models) expect(selectableEffortChoices(group.providerKey, model.model)).not.toContain('ultracode')
    }
  })
})

describe('native new-task project picker', () => {
  const project = (hostId: string, path: string, repositoryKey: string | null): SolusProjectShell => {
    const entry: ProjectEntry = { key: path, path, folderName: path.split('/').at(-1)!, addedAt: '2026-10-01T00:00:00Z', repositoryKey }
    return { key: `${hostId}\u0000${path}`, hostId, hostLabel: hostId, project: entry }
  }
  const projects = [
    project('mac', '/Users/a/solus', 'github.com/solus/solus'),
    project('box', '/home/a/solus', 'github.com/solus/solus'),
    project('mac', '/Users/a/notes', null),
    project('mac', '/Users/a/projects/.solus-chats/abc', null),
  ]

  test('one repository on two hosts is one project; chat folders are not projects', () => {
    const scopes = groupProjectScopes(projects)
    expect(scopes.map((scope) => [scope.title, scope.projects.length])).toEqual([['solus', 2], ['notes', 1]])
  })

  test('picking a project prefers the host the sheet opened on', () => {
    const [solus] = groupProjectScopes(projects)
    expect(getProjectScopeSelectionTarget(solus!, 'box').hostId).toBe('box')
    expect(getProjectScopeSelectionTarget(solus!, null).hostId).toBe('mac')
    expect(scopeOfProject(groupProjectScopes(projects), 'box', '/home/a/solus')?.title).toBe('solus')
  })

  test('search matches names and paths', () => {
    const scopes = groupProjectScopes(projects)
    expect(filterProjectScopes(scopes, 'home/a').map((scope) => scope.title)).toEqual(['solus'])
    expect(filterProjectScopes(scopes, '  ')).toBe(scopes)
  })
})

describe('native composer follow-up delivery', () => {
  async function runningConversation() {
    const api = new FakeApi()
      .on('describeSession', () => ({ lineage: null, meta: null }))
      .on('loadSessionPage', () => ({ messages: [], before: null }))
      .on('watchSession', () => ({ runtime: null }))
      .on('prompt', () => ({ disposition: 'started' }))
    const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
    await world.registry.load()
    await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    const connection = world.connections.connection('inst-a')!
    const transport = world.transports[0] as FakeTransport
    await transport.accept()
    const outboxStorage = memoryKeyValueStore()
    let nextId = 0
    const controller = new ConversationController({
      hostId: 'inst-a',
      record: { sessionId: 'thread-1', provider: 'claude-code', projectPath: '/work/app', cwd: '/work/app', model: null, reasoningEffort: null, title: null, customTitle: null },
    }, {
      executionPreferences: () => ({}),
      connection,
      outbox: new SendOutbox(() => outboxStorage),
      runSettings: async () => ({ defaultPermissionMode: 'supervised' }),
      organizationId: () => null,
      uuid: () => `client-${++nextId}`,
      onChange: () => undefined,
    })
    await controller.load()
    transport.emitSession('thread-1', { type: 'status_change', status: 'running', oldStatus: 'idle' })
    return { api, controller }
  }

  test('a prompt sent during a running turn steers unless the person chose to queue it', async () => {
    const { api, controller } = await runningConversation()
    await controller.send('look at the tests too')
    await controller.send('then update the docs', { delivery: 'queue' })
    expect(api.callsOf('prompt').map((call) => (call[1] as PromptOptions).delivery)).toEqual(['steer', 'queue'])
  })
})
