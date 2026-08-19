import { afterAll, describe, expect, test } from 'bun:test'
import { serverConnections } from '@solus/client-core/server-connections'

const previousLocalStorage = globalThis.localStorage
const previousState = (globalThis as unknown as { $state?: unknown }).$state

const values = new Map<string, string>([
  ['solus.activeServerId', 'local'],
  ['solus.servers', JSON.stringify([{
    id: 'remote',
    label: 'Build host',
    url: 'http://10.10.1.22:3000',
    sessionToken: 'token',
    installationId: 'build-host',
    lastConnected: 1,
  }])],
])

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } satisfies Storage,
})
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

const { serversStore } = await import('@solus/workspace-ui/contexts/connections/servers.store.svelte')

// The store is a module singleton shared with other test files (e.g. server
// removal deletes 'remote' from its in-memory list); re-read this file's
// localStorage so the fixture host exists regardless of execution order.
serversStore.refreshServers()

afterAll(() => {
  if (previousLocalStorage === undefined) {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: previousLocalStorage,
    })
  }
  if (previousState === undefined) {
    delete (globalThis as unknown as { $state?: unknown }).$state
  } else {
    ;(globalThis as unknown as { $state: unknown }).$state = previousState
  }
})

describe('server status', () => {
  test('every host surface follows the same connection transition', () => {
    // WHY: a page mounted while a socket is connecting must advance with the
    // status-bar picker instead of retaining a different snapshot forever.
    serversStore.setConnectionStatus('remote', 'connecting')

    expect(serversStore.statusFor('remote')).toBe('connecting')
    expect(serversStore.servers.find((server) => server.id === 'remote')?.status).toBe('connecting')

    serversStore.setConnectionStatus('remote', 'connected')

    expect(serversStore.statusFor('remote')).toBe('online')
    expect(serversStore.servers.find((server) => server.id === 'remote')?.status).toBe('online')
  })

  test('a fresh failed probe settles a retrying host as offline', async () => {
    // WHY: the socket intentionally retries a saved host forever, but the host
    // picker must not imply that a powered-off machine is about to connect.
    const originalProbeHealth = serverConnections.probeHealth
    let forced = false
    serverConnections.probeHealth = async (_serverId, force) => {
      forced = force === true
      return null
    }

    try {
      serversStore.setConnectionStatus('remote', 'connecting')
      await serversStore.probeHosts()

      expect(forced).toBe(true)
      expect(serversStore.statusFor('remote')).toBe('offline')
      expect(serversStore.servers.find((server) => server.id === 'remote')?.status).toBe('offline')
    } finally {
      serverConnections.probeHealth = originalProbeHealth
    }
  })

  test('a connected socket wins over an older failed probe', () => {
    // WHY: recovering the host must immediately turn it green; users should not
    // have to wait for the next picker probe to clear a stale offline result.
    serversStore.setConnectionStatus('remote', 'connected')

    expect(serversStore.statusFor('remote')).toBe('online')
  })

  test('an identity mismatch is distinct from an offline host', () => {
    // WHY: retrying cannot fix an address that now reaches a different Solus
    // installation. The host row must tell the user to pair deliberately.
    serversStore.setConnectionStatus('remote', 'identity-mismatch')

    expect(serversStore.statusFor('remote')).toBe('different-server')
    expect(serversStore.servers.find((server) => server.id === 'remote')?.status).toBe('different-server')
  })
})
