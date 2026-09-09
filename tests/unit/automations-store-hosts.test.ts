import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Automation } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let AutomationsStore: typeof import('@solus/workspace-ui/contexts/automations/automations.store.svelte')['AutomationsStore']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ AutomationsStore } = await import('@solus/workspace-ui/contexts/automations/automations.store.svelte'))
})

beforeEach(() => connections.reset())

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
    createdBy: { kind: 'user' },
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
