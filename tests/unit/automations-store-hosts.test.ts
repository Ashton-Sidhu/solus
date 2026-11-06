import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Automation, AutomationRun } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let AutomationsStore: typeof import('@solus/workspace-ui/contexts/automations/automations.store.svelte')['AutomationsStore']
let machines: typeof import('@solus/workspace-ui/components/automations/lib/automation-machines')
const defaultCapabilitiesFor = connections.capabilitiesFor

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(<T>(value: T) => value, { snapshot: structuredClone })
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

describe('AutomationsStore clone', () => {
  const action: Automation['action'] = {
    prompt: 'Run checks',
    agentProvider: 'claude',
    modelId: 'claude-opus-5-5',
    reasoningEffort: 'high',
    cwd: '/repo',
    useWorktree: true,
    planRefs: [{ planId: 'plan-1', title: 'Plan', filePath: '/repo/plan.md' }],
    workRefs: [{ workId: 'work-1', title: 'Spec', type: 'doc' }],
  }
  const trigger: Automation['trigger'] = { type: 'cron', expr: '0 9 * * 1', timezone: 'America/Toronto', endsAt: '2027-01-01T00:00:00.000Z' }

  function hostsWith(source: Automation) {
    const created: { name: string; action: Automation['action']; enabled: boolean; trigger: Automation['trigger']; preferences: unknown }[] = []
    connections.registerPrimary('host-a', {
      automationRecentRuns: async () => [],
      automationList: async () => [],
      automationCreate: async () => { throw new Error('clone left the source host') },
    })
    connections.registerHost('host-b', {
      automationRecentRuns: async () => [],
      automationList: async () => [source],
      automationCreate: async (name: string, action: Automation['action'], enabled: boolean, trigger: Automation['trigger'], preferences: unknown) => {
        created.push({ name, action, enabled, trigger, preferences })
        return { ...automation('clone', action.cwd), name, enabled, trigger, action }
      },
    })
    connections.capabilitiesFor = async () => ({ automations: true }) as Awaited<ReturnType<typeof connections.capabilitiesFor>>
    return created
  }

  test('a clone does what the source does, on its host, and starts paused so a schedule does not run twice', async () => {
    const source: Automation = {
      ...automation('nightly', '/repo'),
      name: 'Nightly',
      favorite: true,
      action,
      trigger,
      lastRunStatus: 'failed',
      executionPreferences: { capturedAt: 1, preferences: { extraInstructions: 'Be brief' } },
    }
    const created = hostsWith(source)
    const store = new AutomationsStore()
    store.executionPreferences = () => ({ extraInstructions: 'The cloner, not the source' })
    await store.loadAll('host-b')

    const clone = await store.clone('nightly')

    expect(created).toEqual([{ name: 'Nightly copy', action, enabled: false, trigger, preferences: { extraInstructions: 'Be brief' } }])
    expect(store.hostFor(clone.id)).toBe('host-b')
    expect(store.get('clone')?.favorite).toBeUndefined()
    expect(store.get('clone')?.lastRunStatus).toBeUndefined()
    expect(store.get('nightly')?.enabled).toBe(true)
  })

  test('a source with no captured preferences clones with the current person\'s', async () => {
    const created = hostsWith({ ...automation('nightly', '/repo'), action, trigger })
    const store = new AutomationsStore()
    store.executionPreferences = () => ({ extraInstructions: 'Current' })
    await store.loadAll('host-b')

    await store.clone('nightly')

    expect(created[0].preferences).toEqual({ extraInstructions: 'Current' })
  })
})

describe('AutomationsStore host federation', () => {
  test('loads and exposes only the selected host when the automations page is scoped', async () => {
    let hostAReads = 0
    let hostBReads = 0
    connections.registerPrimary('host-a', {
      automationRecentRuns: async () => [],
      automationList: async () => {
        hostAReads++
        return [automation('a', '/same')]
      },
    })
    connections.registerHost('host-b', {
      automationRecentRuns: async () => [],
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
      automationRecentRuns: async () => [],
      automationList: async () => [automation('a', '/same')],
    })
    connections.registerHost('host-b', {
      automationRecentRuns: async () => [],
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
      automationRecentRuns: async () => [],
      automationList: async () => [],
      automationUpdate: async () => {
        writes.push('host-a')
        return null
      },
    })
    connections.registerHost('host-b', {
      automationRecentRuns: async () => [],
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
      automationRecentRuns: async () => [],
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
      automationRecentRuns: async () => [],
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
    connections.emitReadiness('host-a', 'reconnecting')
    expect(store.loadErrors.has('host-a')).toBe(true)
    connections.emitReadiness('host-a', 'ready')
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
      automationRecentRuns: async () => [],
      automationList: async () => { apiReads++; return [] },
    })
    connections.registerHost(ORG_MACHINE, {
      automationRecentRuns: async () => [],
      automationList: async () => [automation('nightly', '/repo')],
    })
    // The Solus API stores no schedules and says so.
    connections.capabilitiesFor = async (serverId: string) =>
      ({ ...(await defaultCapabilitiesFor()), automations: serverId !== SOLUS_API })
    const store = new AutomationsStore()
    // `serversStore.executionServers` never lists the Solus API.
    const machineIds = machines.automationListMachineIds([
      { id: ORG_MACHINE, label: 'Lab machine', readiness: 'ready' },
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
    connections.registerPrimary('laptop', { automationRecentRuns: async () => [], automationList: async () => [automation('a', '/one')] })
    connections.registerHost('desktop', { automationRecentRuns: async () => [], automationList: async () => [automation('b', '/two')] })
    connections.registerHost('old', { automationRecentRuns: async () => [], automationList: async () => [automation('c', '/three')] })
    connections.capabilitiesFor = async (serverId: string) =>
      ({ ...(await defaultCapabilitiesFor()), automations: serverId !== 'old' })
    const store = new AutomationsStore()
    const machineIds = machines.automationListMachineIds([
      { id: 'laptop', label: 'Laptop', readiness: 'ready' },
      { id: 'desktop', label: 'Desktop', readiness: 'ready' },
      { id: 'old', label: 'Old', readiness: 'ready' },
      { id: 'away', label: 'Away', readiness: 'unreachable' },
    ])

    expect(machineIds).toEqual(['laptop', 'desktop', 'old'])
    await store.loadHosts(machineIds)

    expect(store.itemsForHosts(machineIds).map((item) => item.id).sort()).toEqual(['a', 'b'])
  })

  test('the builder offers execution machines and names a Solus-provisioned machine that is not ready', () => {
    const options = machines.automationMachineOptions(
      [
        { id: 'laptop', label: 'Laptop', readiness: 'ready' },
        { id: 'no-automations', label: 'Old', readiness: 'ready' },
        { id: 'away', label: 'Away', readiness: 'unreachable' },
        {
          id: ORG_MACHINE,
          label: 'Lab machine',
          readiness: 'unreachable',
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
        readiness: 'checking',
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

describe('AutomationsStore run graphs', () => {
  test('a pushed run lands in the list graph, replaced in place as it finishes and capped to the window', () => {
    // The list never loads full run history, so its graph must follow the
    // host's run events, or a run that just finished stays invisible until reload.
    const store = new AutomationsStore()
    const nightly = automation('nightly', '/repo')
    const run = (id: string, status: AutomationRun['status']): AutomationRun => ({
      id, automationId: 'nightly', startedAt: '2026-10-08T12:00:00.000Z', status, output: 'final text',
    })

    store.applyChange('laptop', { kind: 'run-started', automation: nightly, run: run('r1', 'running') })
    store.applyChange('laptop', { kind: 'run-finished', automation: nightly, run: run('r1', 'failed') })
    expect(store.recentRuns.get('nightly')).toEqual([
      { id: 'r1', automationId: 'nightly', startedAt: '2026-10-08T12:00:00.000Z', finishedAt: undefined, status: 'failed' },
    ])

    for (let i = 2; i <= 20; i++) store.applyChange('laptop', { kind: 'run-started', automation: nightly, run: run(`r${i}`, 'running') })
    const graph = store.recentRuns.get('nightly') ?? []
    expect(graph).toHaveLength(17)
    expect(graph[0].id).toBe('r20')
  })
})
