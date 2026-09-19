import { describe, expect, mock, test } from 'bun:test'
import { DEFAULT_HOST_CONFIG, type HostConfigSnapshot } from '@solus/contracts/host-config'
import type { SolusToolPreferences } from '@solus/contracts/agent-tools'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { solusToolsStore: store } = await import('@solus/workspace-ui/components/settings/solus-tools.store.svelte')
const snapshot = (solusTools: SolusToolPreferences): HostConfigSnapshot => ({ seeded: true, config: { ...DEFAULT_HOST_CONFIG, solusTools } })

describe('Solus tool settings store', () => {
  test('writes only the selected host and follows changes from another client', async () => {
    const writes: SolusToolPreferences[] = []
    connections.registerPrimary('primary', { configGet: async () => snapshot({}) })
    connections.registerHost('remote', {
      configGet: async () => snapshot({ read_work: false }),
      configUpdate: async (patch: { solusTools: SolusToolPreferences }) => {
        writes.push(patch.solusTools)
        return snapshot(patch.solusTools)
      },
    })
    const stop = store.watch('remote')
    await store.load('remote')
    expect(store.states.get('remote')?.preferences).toEqual({ read_work: false })
    await store.save('remote', { read_work: true })
    expect(writes).toEqual([{ read_work: true }])
    connections.emit('remote', 'config.changed', snapshot({ ask_jev: false }))
    expect(store.states.get('remote')?.preferences).toEqual({ ask_jev: false })
    stop()
  })
  test('a stale load cannot overwrite a host event', async () => {
    let answer!: (value: HostConfigSnapshot) => void
    connections.registerHost('stale', { configGet: () => new Promise<HostConfigSnapshot>(resolve => { answer = resolve }) })
    const stop = store.watch('stale')
    connections.emit('stale', 'config.changed', snapshot({ read_work: false }))
    answer(snapshot({}))
    await Promise.resolve()
    expect(store.states.get('stale')?.preferences).toEqual({ read_work: false })
    stop()
  })
  test('failed writes keep confirmed values and a retry can recover', async () => {
    connections.registerHost('failed', {
      configGet: async () => snapshot({}),
      configUpdate: async () => { throw new Error('offline') },
    })
    await store.load('failed')
    await store.save('failed', { read_work: false })
    expect(store.states.get('failed')?.preferences).toEqual({})
    expect(store.states.get('failed')?.error).toContain('Could not save')
    await store.load('failed')
    expect(store.states.get('failed')?.error).toBe('')
  })
  test('disconnect invalidates in-flight reads; reconnect reloads choices', async () => {
    let answer!: (value: HostConfigSnapshot) => void
    connections.registerHost('reconnect', { configGet: () => new Promise<HostConfigSnapshot>(resolve => { answer = resolve }) })
    const stop = store.watch('reconnect')
    connections.emitStatus('reconnect', 'reconnecting')
    answer(snapshot({}))
    await Promise.resolve()
    expect(store.states.get('reconnect')?.error).toBe('Host disconnected.')
    connections.emitStatus('reconnect', 'connected')
    answer(snapshot({ read_work: false }))
    await Promise.resolve()
    expect(store.states.get('reconnect')?.preferences).toEqual({ read_work: false })
    expect(store.states.get('reconnect')?.error).toBe('')
    stop()
  })
})

test('key saves use the selected host and key status follows other clients', async () => {
  const writes: (string | null)[] = []
  connections.registerHost('key-host', {
    configGet: async () => ({ ...snapshot({}), typeSafe: { source: null } }),
    typeSafeKeySet: async (key: string | null) => {
      writes.push(key)
      return { ...snapshot({}), typeSafe: { source: key ? 'saved' : null } }
    },
  })
  const stop = store.watch('key-host')
  await store.load('key-host')
  expect(await store.saveKey('key-host', 'synthetic-key')).toBe(true)
  expect(store.states.get('key-host')?.typeSafe?.source).toBe('saved')
  expect(JSON.stringify(store.states.get('key-host'))).not.toContain('synthetic-key')
  expect(await store.saveKey('key-host', null)).toBe(true)
  expect(store.states.get('key-host')?.typeSafe?.source).toBe(null)
  expect(writes).toEqual(['synthetic-key', null])
  connections.emit('key-host', 'config.changed', { ...snapshot({}), typeSafe: { source: 'environment' } })
  expect(store.states.get('key-host')?.typeSafe?.source).toBe('environment')
  stop()
})
