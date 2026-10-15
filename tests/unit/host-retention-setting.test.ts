import { describe, expect, mock, test } from 'bun:test'
import { DEFAULT_HOST_CONFIG, type HostConfigSnapshot } from '@solus/contracts/host-config'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { automationRetentionStore: store, recordingRetentionStore } = await import('@solus/workspace-ui/contexts/hosts/host-retention.store.svelte')
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

  test('recording retention reads and writes its own key', async () => {
    // WHY: two settings share one store class; each must change only its own key.
    const patches: object[] = []
    connections.registerHost('recordings', {
      configGet: async () => ({ seeded: true, config: { ...DEFAULT_HOST_CONFIG, unfiledRecordingRetentionDays: 30 } }),
      configUpdate: async (patch: { unfiledRecordingRetentionDays: number }) => {
        patches.push(patch)
        return { seeded: true, config: { ...DEFAULT_HOST_CONFIG, ...patch } }
      },
    })
    const stop = recordingRetentionStore.watch('recordings')
    await recordingRetentionStore.load('recordings')
    expect(recordingRetentionStore.states.get('recordings')?.days).toBe(30)
    await recordingRetentionStore.save('recordings', 3)
    expect(patches).toEqual([{ unfiledRecordingRetentionDays: 3 }])
    expect(recordingRetentionStore.states.get('recordings')?.days).toBe(3)
    stop()
  })
})
