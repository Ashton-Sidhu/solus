import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import { HostRpcError } from '@solus/client-core/rpc-error'
import { sessionPolicy } from '@solus/client-core/policy'
import type { PolicyDocument, PolicySet, PolicySource } from '@solus/contracts/policy'
import type { IpcContext } from '@solus/contracts/types'
import { ConversationController } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { buildProviderGroups, permissionModeChoices } from '../../apps/mobile/src/features/threads/thread-settings-options'
import { hostLockMessage, pairingLockMessage, policyScreenModel, updatesLockMessage } from '../../apps/mobile/src/features/policy/lib/policy-view'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, flushPromises, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

// plans/030 §7 on the phone. Mobile shows the effective policy and every lock
// but does not edit or export (O1). The rules pinned here are the ones a
// person would notice going wrong: the screen names the policy that wins each
// rule, in the host's order; another organization's policy never shows for
// this work; a mode, agent, or model the policy refuses is disabled with its
// reason; new work starts at the ceiling; and a refused prompt offers the one
// fix, "Lower the mode".

function source(kind: PolicySource['kind'], organizationId: string | null, document: Omit<PolicyDocument, 'schemaVersion'>): PolicySource {
  return { kind, organizationId, document: { schemaVersion: 1, ...document } }
}

const MDM = source('mdm', null, {
  organization: { name: 'Example Corp' },
  supportUrl: 'https://it.example.com/solus',
  host: { remoteAccess: false, updates: { mode: 'off' } },
  sessions: { settings: { extraInstructions: 'Never push to main.' } },
})

const GLOBEX_HOST = source('host', 'org-globex', {
  organization: { name: 'Globex' },
  name: 'Globex laptops',
  revision: 4,
  sessions: { limits: { maxPermissionMode: 'supervised', models: { 'claude-code': ['claude-opus-5-5'] } } },
})

const GLOBEX = source('organization', 'org-globex', {
  organization: { name: 'Globex' },
  revision: 9,
  // The host policy's ceiling wins over this one: it comes first.
  sessions: { limits: { maxPermissionMode: 'full-access', providers: { allowed: ['claude-code'] }, insights: { syncAll: true } } },
})

const ACME = source('organization', 'org-acme', { organization: { name: 'Acme' }, sessions: { settings: { leadInstructions: 'Acme only.' } } })

function policySet(overrides: Partial<PolicySet> = {}): PolicySet {
  return {
    mdm: null,
    hostOwnerOrganizationId: null,
    organizations: {
      'org-globex': { state: 'ready', policy: GLOBEX, hostPolicy: GLOBEX_HOST },
      'org-acme': { state: 'ready', policy: ACME, hostPolicy: null },
      'org-new': { state: 'unavailable' },
    },
    ...overrides,
  }
}

const NAMES = new Map([['org-globex', 'Globex'], ['org-acme', 'Acme']])

describe('the Policy screen', () => {
  test('lists the policies that apply in the host\'s order, and names the one that sets each rule', () => {
    const model = policyScreenModel(policySet({ mdm: MDM }), 'org-globex', NAMES)
    expect(model.sources.map((row) => [row.heading, row.name])).toEqual([
      ['MDM policy', 'Example Corp'],
      ['Host policy', 'Globex laptops'],
      ['Organization policy', 'Globex'],
    ])
    expect(model.sources[1]?.detail).toBe('Managed by Globex · Revision 4')
    expect(model.limits).toContainEqual({ label: 'Highest mode', value: 'Supervised', source: 'Globex laptops (Globex)' })
    expect(model.limits).toContainEqual({ label: 'Agents', value: 'Claude', source: 'Globex' })
    expect(model.limits).toContainEqual({ label: 'Sync all Insights', value: 'On', source: 'Globex' })
    expect(model.settings).toEqual([{ label: 'Extra instructions', value: 'set custom instructions', source: 'the MDM policy of Example Corp' }])
    expect(model.hostKeys).toContainEqual({ label: 'Remote access', value: 'This machine only', source: 'the MDM policy of Example Corp' })
    expect(model.supportUrl).toBe('https://it.example.com/solus')
    expect(model.refusal).toBeNull()
  })

  test('work of one organization never shows another organization\'s policy, and personal work sees only the MDM policy', () => {
    const acme = policyScreenModel(policySet(), 'org-acme', NAMES)
    expect(acme.sources.map((row) => row.name)).toEqual(['Acme'])
    expect(acme.limits).toEqual([])
    expect(acme.settings.map((row) => row.label)).toEqual(['Lead instructions'])

    const personal = policyScreenModel(policySet({ mdm: MDM }), 'local', NAMES)
    expect(personal.sources.map((row) => row.kind)).toEqual(['mdm'])
    expect(personal.limits).toEqual([])
  })

  test('an organization the host has no policy for says so, and the MDM policy still shows', () => {
    const model = policyScreenModel(policySet({ mdm: MDM }), 'org-new', NAMES)
    expect(model.refusal).toContain('has not received this organization\'s policy')
    expect(model.sources.map((row) => row.kind)).toEqual(['mdm'])
  })

  test('the host-owning organization is named, and its host keys lock the host\'s controls', () => {
    const owned = policySet({
      hostOwnerOrganizationId: 'org-globex',
      organizations: { 'org-globex': { state: 'ready', policy: GLOBEX, hostPolicy: source('host', 'org-globex', { organization: { name: 'Globex' }, name: 'Globex laptops', host: { cloudTunnel: false } }) } },
    })
    expect(policyScreenModel(owned, 'local', NAMES).hostOwner).toBe('Globex manages this host\'s settings.')
    expect(hostLockMessage(owned, 'cloudTunnel')).toBe('The Solus Cloud link is managed by Globex laptops (Globex).')
    expect(hostLockMessage(owned, 'remoteAccess')).toBeNull()

    const mdm = policySet({ mdm: MDM })
    expect(pairingLockMessage(mdm)).toBe('Pairing is managed by the MDM policy of Example Corp.')
    expect(updatesLockMessage(mdm)).toBe('Example Corp manages Solus updates.')
    // No summary read yet locks nothing.
    expect(hostLockMessage(null, 'remoteAccess')).toBeNull()
  })
})

describe('the session pickers', () => {
  const globex = sessionPolicy(policySet(), 'org-globex')

  test('modes above the ceiling stay listed, disabled, with the policy\'s reason', () => {
    const choices = permissionModeChoices(undefined, globex)
    expect(choices.filter((choice) => choice.policyDenial).map((choice) => choice.mode)).toEqual(['accept-edits', 'auto', 'full-access'])
    expect(choices.find((choice) => choice.mode === 'auto')?.policyDenial).toBe('Globex laptops (Globex) limits sessions to Supervised.')
    expect(choices.find((choice) => choice.mode === 'plan')?.policyDenial).toBeNull()
  })

  test('an agent and a model the policy does not allow are marked with the reason; another organization\'s work is not', () => {
    const groups = buildProviderGroups({ currentProvider: 'claude-code', currentModel: null, canSwitchProvider: true, agents: null, policy: globex })
    expect(groups.find((group) => group.providerKey === 'codex')?.unavailableReason).toBe('Globex does not allow Codex.')
    const claude = groups.find((group) => group.providerKey === 'claude-code')!
    expect(claude.unavailableReason).toBeNull()
    expect(claude.models.find((model) => model.model === 'claude-opus-5-5')?.policyDenial).toBeNull()
    expect(claude.models.find((model) => model.model !== 'claude-opus-5-5')?.policyDenial).toContain('does not allow the model')

    const acme = buildProviderGroups({ currentProvider: 'claude-code', currentModel: null, canSwitchProvider: true, agents: null, policy: sessionPolicy(policySet(), 'org-acme') })
    expect(acme.flatMap((group) => group.models).every((model) => model.policyDenial === null)).toBe(true)
  })
})

describe('the conversation under a ceiling', () => {
  async function open(api: FakeApi) {
    const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
    await world.registry.load()
    await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
    const connection = world.connections.connection('inst-a')!
    await (world.transports[0] as FakeTransport).accept()
    const outboxStorage = memoryKeyValueStore()
    let nextId = 0
    const controller = new ConversationController({ hostId: 'inst-a', newSession: { sessionId: 'new-1', provider: 'claude-code', workingDirectory: '/work/app' } }, {
      executionPreferences: () => ({}),
      connection,
      outbox: new SendOutbox(() => outboxStorage),
      runSettings: async () => ({ defaultPermissionMode: 'full-access', defaultModels: {}, modelOptionsByProvider: {} }),
      organizationId: () => 'org-globex',
      uuid: () => `client-${++nextId}`,
      onChange: () => undefined,
    })
    return { controller, connection }
  }

  function api(set: PolicySet = policySet()) {
    return new FakeApi()
      .on('hostPolicy', () => set)
      .on('watchSession', () => ({}))
      .on('typeSafeKeyStatus', () => ({ source: 'host' }))
  }

  test('new work starts at the ceiling, and a mode above it cannot be picked; lowering always can', async () => {
    const { controller, connection } = await open(api())
    await connection.facts.when('policy')
    await controller.load()
    expect(controller.run.permissionMode).toBe('supervised')
    expect(controller.updateRun({ permissionMode: 'full-access' })).toBe(false)
    expect(controller.run.permissionMode).toBe('supervised')
    expect(controller.updateRun({ permissionMode: 'plan' })).toBe(true)
    expect(controller.run.permissionMode).toBe('plan')
    controller.close()
  })

  test('a policy that arrives after the defaults lowers work that has not started', async () => {
    let release!: (set: PolicySet) => void
    const fake = api().on('hostPolicy', () => new Promise<PolicySet>((resolve) => { release = resolve }))
    const { controller } = await open(fake)
    await controller.load()
    expect(controller.run.permissionMode).toBe('full-access')
    release(policySet())
    await flushPromises()
    expect(controller.run.permissionMode).toBe('supervised')
    controller.close()
  })

  test('a prompt refused for its mode shows the host\'s words and offers "Lower the mode", which sends it again at the ceiling', async () => {
    let ceilingSet = policySet({ organizations: { 'org-globex': { state: 'ready', policy: GLOBEX, hostPolicy: null } } })
    const fake = api(ceilingSet)
    const { controller, connection } = await open(fake)
    await connection.facts.when('policy')
    await controller.load()
    expect(controller.run.permissionMode).toBe('full-access')
    // The policy changes while the person works: Globex's host policy now limits sessions.
    ceilingSet = policySet()
    connection.facts.set('policy', ceilingSet)
    let refuse = true
    fake.on('prompt', () => {
      if (refuse) throw new HostRpcError('Globex laptops (Globex) limits sessions to Supervised.', 'PERMISSION_MODE_ABOVE_LIMIT')
      return { disposition: 'started' }
    })
    controller.run.permissionMode = 'full-access'
    await controller.send('go')
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'failed', error: 'Globex laptops (Globex) limits sessions to Supervised.' })
    expect(controller.lowerModeFor('client-1')).toBe('supervised')

    refuse = false
    await controller.lowerModeAndRetry('client-1')
    const prompts = fake.callsOf('prompt') as [IpcContext][]
    expect(prompts.at(-1)?.[0].session.permissionMode).toBe('supervised')
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'sent' })
    controller.close()
  })

  test('another refusal keeps its words and offers no lower mode', async () => {
    const fake = api().on('prompt', () => { throw new HostRpcError('Globex does not allow Codex.', 'PROVIDER_NOT_ALLOWED') })
    const { controller } = await open(fake)
    await controller.load()
    await controller.send('go')
    expect(controller.model.items.get('client-1')).toMatchObject({ delivery: 'failed', error: 'Globex does not allow Codex.' })
    expect(controller.lowerModeFor('client-1')).toBeNull()
    controller.close()
  })
})
