import { describe, expect, mock, test } from 'bun:test'
import { DEFAULT_HOST_CONFIG, type HostConfigSnapshot } from '@solus/contracts/host-config'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { automationRetentionStore: store } = await import('@solus/workspace-ui/contexts/automations/automation-retention.store.svelte')
const snapshot = (days: number): HostConfigSnapshot => ({ seeded: true, config: { ...DEFAULT_HOST_CONFIG, archivedAutomationRetentionDays: days } })

describe('archive retention settings', () => {
  test('reads and writes the selected host and adopts changes from another client', async () => {
    const writes: number[] = []
    connections.registerPrimary('primary', { configGet: async () => snapshot(30) })
    connections.registerHost('remote', {
      configGet: async () => snapshot(14),
      configUpdate: async (patch: { archivedAutomationRetentionDays: number }) => {
        writes.push(patch.archivedAutomationRetentionDays)
        return snapshot(patch.archivedAutomationRetentionDays)
      },
    })
    const stop = store.watch('remote')
    await store.load('remote')
    expect(store.states.get('remote')?.days).toBe(14)
    await store.save('remote', 7)
    expect(writes).toEqual([7])
    expect(store.states.get('remote')?.days).toBe(7)
    connections.emit('remote', 'config.changed', snapshot(90))
    expect(store.states.get('remote')?.days).toBe(90)
    await store.save('remote', 0)
    expect(writes).toEqual([7])
    expect(store.states.get('remote')?.error).toContain('whole number')
    stop()
  })

  test('a stale settings read cannot replace a newer host event', async () => {
    let answer!: (value: HostConfigSnapshot) => void
    connections.registerHost('stale', {
      configGet: () => new Promise<HostConfigSnapshot>(resolve => { answer = resolve }),
    })
    const stop = store.watch('stale')
    connections.emit('stale', 'config.changed', snapshot(60))
    answer(snapshot(30))
    await Promise.resolve()
    expect(store.states.get('stale')?.days).toBe(60)
    stop()
  })
})
