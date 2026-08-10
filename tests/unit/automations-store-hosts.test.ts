import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Automation } from '../../src/shared/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@client-core/server-connections', () => ({ serverConnections: connections }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let AutomationsStore: typeof import('../../src/renderer/contexts/automations/automations.store.svelte')['AutomationsStore']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ AutomationsStore } = await import('../../src/renderer/contexts/automations/automations.store.svelte'))
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
})
