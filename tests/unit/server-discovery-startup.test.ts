import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'

mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))
mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({ notificationsStore: { wants: () => false } }))

const runtime = globalThis as typeof globalThis & { $state?: <T>(value: T) => T }
const previousState = runtime.$state
const previousDocument = globalThis.document
const previousStorage = globalThis.localStorage
const values = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
  clear: () => values.clear(),
  key: (index: number) => [...values.keys()][index] ?? null,
  get length() { return values.size },
} satisfies Storage })
runtime.$state = <T>(value: T) => value
const { serversStore } = await import('@solus/workspace-ui/contexts/connections/servers.store.svelte')

afterAll(() => {
  if (previousState) runtime.$state = previousState
  else delete runtime.$state
  Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: previousStorage, configurable: true })
})

describe('startup discovery scans', () => {
  test('automatic scans reuse a recent result, while a user can request a fresh scan', async () => {
    let now = 100_000
    let calls = 0
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    const defaultHost = spyOn(serverConnections, 'defaultServerId').mockReturnValue('scan-host')
    const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
      discoverServers: async () => { calls++; return [] },
    }))
    try {
      await serversStore.scanForServers({ onlyIfStale: true })
      now += 17_000
      await serversStore.scanForServers({ onlyIfStale: true })
      expect(calls).toBe(1)
      await serversStore.scanForServers()
      expect(calls).toBe(2)
      now += 30_001
      await serversStore.scanForServers({ onlyIfStale: true })
      expect(calls).toBe(3)
    } finally {
      api.mockRestore()
      defaultHost.mockRestore()
      clock.mockRestore()
    }
  })

  test('focus and connection signals share one discovery timer', () => {
    let isFocused = true
    Object.defineProperty(globalThis, 'document', { value: {
      hidden: false, hasFocus: () => isFocused,
    }, configurable: true })
    const scan = spyOn(serversStore, 'scanForServers').mockResolvedValue(null)
    const discovery = serversStore as unknown as { updateAutoDiscovery(): void }
    try {
      discovery.updateAutoDiscovery()
      discovery.updateAutoDiscovery()
      discovery.updateAutoDiscovery()
      expect(scan).toHaveBeenCalledTimes(1)
      isFocused = false
      discovery.updateAutoDiscovery()
      isFocused = true
      discovery.updateAutoDiscovery()
      expect(scan).toHaveBeenCalledTimes(2)
      expect(scan.mock.calls[0]).toEqual([{ onlyIfStale: true }])
    } finally {
      isFocused = false
      discovery.updateAutoDiscovery()
      scan.mockRestore()
    }
  })
})
