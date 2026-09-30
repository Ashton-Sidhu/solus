import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Automation } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let AutomationsStore: typeof import('@solus/workspace-ui/contexts/automations/automations.store.svelte')['AutomationsStore']
let machines: typeof import('@solus/workspace-ui/components/automations/lib/automation-machines')
const defaultCapabilitiesFor = connections.capabilitiesFor

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ AutomationsStore } = await import('@solus/workspace-ui/contexts/automations/automations.store.svelte'))
  machines = await import('@solus/workspace-ui/components/automations/lib/automation-machines')
})

beforeEach(() => {
  connections.reset()
  connections.capabilitiesFor = defaultCapabilitiesFor
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function automation(id: string, cwd: string): Automation {
  return {
    id,
    name: id,
    enabled: true,
    action: {
      prompt: 'Run checks',
      agentProvider: 'codex',
      modelId: null,
      reasoningEffort: 'medium',
      cwd,
    },
    trigger: { type: 'manual' },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    createdBy: { kind: 'system' },
  }
}

describe('AutomationsStore host federation', () => {
  test('loads and exposes only the selected host when the automations page is scoped', async () => {
    let hostAReads = 0
    let hostBReads = 0
    connections.registerPrimary('host-a', {
      automationList: async () => {
        hostAReads++
        return [automation('a', '/same')]
      },
    })
    connections.registerHost('host-b', {
      automationList: async () => {
        hostBReads++
        return [automation('b', '/same')]
      },
    })
    const store = new AutomationsStore()

    await store.loadAll('host-b')

    expect(hostAReads).toBe(0)
    expect(hostBReads).toBe(1)
    expect(store.itemsForHost('host-b').map((item) => item.id)).toEqual(['b'])
    expect(store.itemsForHost('host-a')).toEqual([])
    expect(store.hasLoadedHost('host-b')).toBe(true)
  })

  test('unions connected hosts without evicting a host whose list failed', async () => {
    let hostBShouldFail = false
    connections.registerPrimary('host-a', {
      automationList: async () => [automation('a', '/same')],
    })
    connections.registerHost('host-b', {
      automationList: async () => {
        if (hostBShouldFail) throw new Error('offline')
        return [automation('b', '/same')]
      },
    })
    const store = new AutomationsStore()

    await store.loadAll()
    expect(store.items.map((item) => item.id).sort()).toEqual(['a', 'b'])
    expect(store.hostFor('a')).toBe('host-a')
    expect(store.hostFor('b')).toBe('host-b')

    hostBShouldFail = true
    await store.loadAll()
    expect(store.items.map((item) => item.id).sort()).toEqual(['a', 'b'])
  })

  test('routes writes to the host that owns the automation', async () => {
    const writes: string[] = []
    const owned = automation('remote', '/repo')
    connections.registerPrimary('host-a', {
      automationList: async () => [],
      automationUpdate: async () => {
        writes.push('host-a')
        return null
      },
    })
    connections.registerHost('host-b', {
      automationList: async () => [owned],
      automationUpdate: async (_id: string, patch: { name?: string }) => {
        writes.push('host-b')
        return { ...owned, name: patch.name ?? owned.name }
      },
    })
    const store = new AutomationsStore()

    await store.loadAll()
    await store.update('remote', { name: 'Updated' })

    expect(writes).toEqual(['host-b'])
    expect(store.get('remote')?.name).toBe('Updated')
  })
  test('an old list response cannot undo a live stop or restore a deleted schedule', async () => {
    const original = automation('scheduled', '/repo')
    let answer!: (items: Automation[]) => void
    connections.registerPrimary('host-a', {
      automationList: () => new Promise<Automation[]>(resolve => { answer = resolve }),
    })
    const store = new AutomationsStore()
    store.applyChange('host-a', { kind: 'saved', automation: original })
    const loading = store.loadAll('host-a')
    // Capabilities resolve before the list request starts.
    await Promise.resolve()
    const stopped = { ...original, enabled: false }
    store.applyChange('host-a', { kind: 'saved', automation: stopped })
    answer([original])
    await loading
    expect(store.get(original.id)?.enabled).toBe(false)

    const reloading = store.loadAll('host-a')
    await Promise.resolve()
    store.applyChange('host-a', { kind: 'deleted', automationId: original.id })
    answer([original])
    await reloading
    expect(store.get(original.id)).toBeUndefined()
  })

  test('mounted cards share updates and reload schedule state after reconnect', async () => {
    let reads = 0
    const original = automation('watched', '/repo')
    connections.registerPrimary('host-a', {
      automationList: async () => { reads++; return [original] },
    })
    const store = new AutomationsStore()
    const first = store.watchHost('host-a')
    const second = store.watchHost('host-a')
    await store.loadAll('host-a')
    expect(reads).toBe(1)
    connections.emit('host-a', 'automation.changed', {
      kind: 'saved', automation: { ...original, enabled: false },
    })
    expect(store.get(original.id)?.enabled).toBe(false)
    connections.emitStatus('host-a', 'disconnected')
    expect(store.loadErrors.has('host-a')).toBe(true)
    connections.emitStatus('host-a', 'connected')
    await store.loadAll('host-a')
    expect(reads).toBe(2)
    expect(store.loadErrors.has('host-a')).toBe(false)
    first()
    connections.emit('host-a', 'automation.changed', {
      kind: 'saved', automation: { ...original, enabled: false },
    })
    expect(store.get(original.id)?.enabled).toBe(false)
    second()
    connections.emit('host-a', 'automation.changed', { kind: 'saved', automation: original })
    expect(store.get(original.id)?.enabled).toBe(false)
  })

})

describe('automations live on execution machines (plan 004, item 2)', () => {
  const SOLUS_API = 'workspace:org-1'
  const ORG_MACHINE = 'org-machine'

  test('at a Solus Cloud origin the page lists the organization machine, not the Solus API primary', async () => {
    let apiReads = 0
    connections.registerPrimary(SOLUS_API, {
      automationList: async () => { apiReads++; return [] },
    })
    connections.registerHost(ORG_MACHINE, {
      automationList: async () => [automation('nightly', '/repo')],
    })
    // The Solus API stores no schedules and says so.
    connections.capabilitiesFor = async (serverId: string) =>
      ({ ...(await defaultCapabilitiesFor()), automations: serverId !== SOLUS_API })
    const store = new AutomationsStore()
    // `serversStore.executionServers` never lists the Solus API.
    const machineIds = machines.automationListMachineIds([
      { id: ORG_MACHINE, label: 'Lab machine', status: 'online' },
    ])

    await store.loadHosts(machineIds)

    expect(apiReads).toBe(0)
    expect(store.itemsForHosts(machineIds).map((item) => item.id)).toEqual(['nightly'])
    expect(store.hostFor('nightly')).toBe(ORG_MACHINE)
    // What the page showed before: the primary's list, which is empty there.
    expect(store.itemsForHost(SOLUS_API)).toEqual([])
    expect(store.isInitialLoadingHosts(machineIds)).toBe(false)
  })

  test('merges every connected machine and skips one without the automations capability', async () => {
    connections.registerPrimary('laptop', { automationList: async () => [automation('a', '/one')] })
    connections.registerHost('desktop', { automationList: async () => [automation('b', '/two')] })
    connections.registerHost('old', { automationList: async () => [automation('c', '/three')] })
    connections.capabilitiesFor = async (serverId: string) =>
      ({ ...(await defaultCapabilitiesFor()), automations: serverId !== 'old' })
    const store = new AutomationsStore()
    const machineIds = machines.automationListMachineIds([
      { id: 'laptop', label: 'Laptop', status: 'online' },
      { id: 'desktop', label: 'Desktop', status: 'online' },
      { id: 'old', label: 'Old', status: 'online' },
      { id: 'away', label: 'Away', status: 'offline' },
    ])

    expect(machineIds).toEqual(['laptop', 'desktop', 'old'])
    await store.loadHosts(machineIds)

    expect(store.itemsForHosts(machineIds).map((item) => item.id).sort()).toEqual(['a', 'b'])
  })

  test('the builder offers execution machines and names a Solus-provisioned machine that is not ready', () => {
    const options = machines.automationMachineOptions(
      [
        { id: 'laptop', label: 'Laptop', status: 'online' },
        { id: 'no-automations', label: 'Old', status: 'online' },
        { id: 'away', label: 'Away', status: 'offline' },
        {
          id: ORG_MACHINE,
          label: 'Lab machine',
          status: 'offline',
          uplink: { hostId: 'h', directoryUrl: 'https://app.solus.sh', kind: 'managed', managedState: 'stopped' },
        },
      ],
      (serverId) => serverId !== 'no-automations',
    )

    expect(options).toEqual([
      { value: 'laptop', label: 'Laptop', disabled: false },
      { value: ORG_MACHINE, label: 'Lab machine · Stopped', disabled: true },
    ])
    expect(machines.canSaveAutomationTo(options, 'laptop')).toBe(true)
    // A stopped machine is visible but takes no new automation.
    expect(machines.canSaveAutomationTo(options, ORG_MACHINE)).toBe(false)
    expect(machines.selectableAutomationMachine(options, ORG_MACHINE)).toBe('laptop')
  })

  test('with no machine to choose the builder cannot save', () => {
    const starting = machines.automationMachineOptions(
      [{
        id: ORG_MACHINE,
        label: 'Lab machine',
        status: 'connecting',
        uplink: { hostId: 'h', directoryUrl: 'https://app.solus.sh', kind: 'managed', managedState: 'starting' },
      }],
      () => true,
    )

    expect(starting.map((option) => option.label)).toEqual(['Lab machine · Starting'])
    expect(machines.selectableAutomationMachine(starting, '')).toBe('')
    expect(machines.canSaveAutomationTo(starting, '')).toBe(false)
    expect(machines.canSaveAutomationTo([], 'laptop')).toBe(false)
    expect(machines.NO_MACHINE_LABEL).toBe('Choose a machine')
  })
})
