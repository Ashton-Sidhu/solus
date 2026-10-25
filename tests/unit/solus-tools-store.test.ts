import { describe, expect, mock, test } from 'bun:test'
import { DEFAULT_HOST_CONFIG, type HostConfigSnapshot, type TypeSafeKeyStatus } from '@solus/contracts/host-config'
import type { SolusToolPreferences } from '@solus/contracts/agent-tools'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { solusToolsStore: store } = await import('@solus/workspace-ui/components/settings/solus-tools.store.svelte')
/** Lets a load that waits on two answers settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
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
    connections.emitReadiness('reconnect', 'reconnecting')
    answer(snapshot({}))
    await Promise.resolve()
    expect(store.states.get('reconnect')?.error).toBe('Host disconnected.')
    connections.emitReadiness('reconnect', 'ready')
    answer(snapshot({ read_work: false }))
    await settle()
    expect(store.states.get('reconnect')?.preferences).toEqual({ read_work: false })
    expect(store.states.get('reconnect')?.error).toBe('')
    stop()
  })
})

test('key saves use the selected host and key status follows other clients', async () => {
  const writes: (string | null)[] = []
  let status: TypeSafeKeyStatus = { location: 'host', source: null }
  connections.registerHost('key-host', {
    configGet: async () => snapshot({}),
    typeSafeKeyStatus: async () => status,
    typeSafeKeySet: async (key: string | null) => {
      writes.push(key)
      status = { location: 'host', source: key ? 'saved' : null }
      return status
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
  // Another window of the same person saved a key: the event names no key, so the store reads its own again.
  status = { location: 'host', source: 'environment' }
  connections.emit('key-host', 'config.changed', snapshot({}))
  await settle()
  expect(store.states.get('key-host')?.typeSafe?.source).toBe('environment')
  stop()
})

test('a member\'s key is in their account: the store never saves it on the host', async () => {
  // WHY: access-model.md §2.6 — the host keeps a TypeSafe key only for its own user.
  const writes: (string | null)[] = []
  connections.registerHost('member-host', {
    configGet: async () => snapshot({}),
    typeSafeKeyStatus: async () => ({ location: 'account', source: null }),
    typeSafeKeySet: async (key: string | null) => { writes.push(key); return { location: 'account', source: null } },
  })
  await store.load('member-host')
  expect(store.isTypeSafeKeyMissing('member-host')).toBe(true)
  expect(await store.saveKey('member-host', 'synthetic-key')).toBe(false)
  expect(writes).toEqual([])
})

// Auto and model routing lock on this answer, so a host that has not answered
// yet, or is too old to report a key, must not lock them.
test('a key is missing only when the host says it has none', async () => {
  let answer!: (value: TypeSafeKeyStatus) => void
  connections.registerHost('lock-host', {
    configGet: async () => snapshot({}),
    typeSafeKeyStatus: () => new Promise<TypeSafeKeyStatus>(resolve => { answer = resolve }),
  })
  const stop = store.watch('lock-host')
  expect(store.isTypeSafeKeyMissing('lock-host')).toBe(false)
  answer({ location: 'host', source: null })
  await settle()
  expect(store.isTypeSafeKeyMissing('lock-host')).toBe(true)
  stop()
  // An older host has no such method: unknown, not missing.
  connections.registerHost('old-host', { configGet: async () => snapshot({}) })
  await store.load('old-host')
  expect(store.isTypeSafeKeyMissing('old-host')).toBe(false)
})
