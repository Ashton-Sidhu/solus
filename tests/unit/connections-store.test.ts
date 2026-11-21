import { afterEach, describe, expect, mock, test } from 'bun:test'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const mockedServerConnections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: mockedServerConnections,
}))

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('remote access settings', () => {
  test('updates the switch state before the server reconnect finishes', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    let finishRebind!: () => void
    const rebind = new Promise<void>((resolve) => { finishRebind = resolve })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: {
        connectionsSetRemoteAccess: async () => {
          await rebind
          return { remoteAccess: 'off', host: '127.0.0.1', port: 3000, allowLan: false, requireAuth: false }
        },
        connectionsGetServerInfo: async () => ({
          installationId: 'test',
          remoteAccess: 'off',
          host: '127.0.0.1',
          port: 3000,
          allowLan: false,
          requireAuth: false,
          trustLocalNetwork: false,
          hostKind: 'personal',
        }),
        connectionsListEndpoints: async () => [],
        connectionsListSessions: async () => [],
      } },
    })
    const { ConnectionsStore } = await import('@solus/workspace-ui/contexts/connections/connections.store.svelte')
    const store = new ConnectionsStore()
    store.serverInfo = {
      installationId: 'test',
      remoteAccess: 'any',
      host: '0.0.0.0',
      port: 3000,
      allowLan: true,
      requireAuth: true,
      trustLocalNetwork: false,
      hostKind: 'personal',
    }

    const update = store.setRemoteAccess('local', 'off')

    expect(store.serverInfo.remoteAccess).toBe('off')
    expect(store.remoteAccessUpdating).toBe(true)

    finishRebind()
    await update
    expect(store.remoteAccessUpdating).toBe(false)
    expect(store.serverInfo.allowLan).toBe(false)
  })
})

describe('provider host routing', () => {
  test('loads GitHub status from the host named by settings', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    mockedServerConnections.registerHost('laptop', {
      providerStatus: async () => ({ connected: true, login: 'laptop-user' }),
    })
    mockedServerConnections.registerHost('studio', {
      providerStatus: async () => ({ connected: true, login: 'studio-user' }),
    })
    const { ConnectionsStore } = await import('@solus/workspace-ui/contexts/connections/connections.store.svelte')
    const store = new ConnectionsStore()

    await Reflect.apply(store.refreshProviderStatus, store, ['studio', {}])

    expect(store.providerStatus).toEqual({ connected: true, login: 'studio-user' })
  })
})

describe('paired devices on the Access tab', () => {
  test('a refused read of the pairings says why, and the rest of the tab still loads', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const info = { installationId: 'box', remoteAccess: 'any', host: '0.0.0.0', port: 3000, allowLan: true, requireAuth: true, trustLocalNetwork: false, hostKind: 'personal', principal: 'org-member' }
    mockedServerConnections.registerHost('box', {
      connectionsGetServerInfo: async () => info,
      connectionsListEndpoints: async () => [],
      connectionsListSessions: async () => [],
      connectionsListDevices: async () => { throw new Error('only the host administrator') },
    })
    const { ConnectionsStore } = await import('@solus/workspace-ui/contexts/connections/connections.store.svelte')
    const store = new ConnectionsStore()

    await store.refreshServerMetadata('box')

    expect(store.serverInfo).toEqual(info)
    expect(store.pairedDevicesLoaded).toBe(true)
    expect(store.pairedDevicesError).toBe('only the host administrator')
  })

  test('a device that paired and is offline is listed', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const tablet = { deviceId: 'd2', deviceLabel: 'Tablet', pairedAt: 1, lastSeenAt: 2, revokedAt: null }
    mockedServerConnections.registerHost('desk', {
      connectionsGetServerInfo: async () => ({ installationId: 'desk', hostKind: 'personal', principal: 'local-owner' }),
      connectionsListEndpoints: async () => [],
      connectionsListSessions: async () => [],
      connectionsListDevices: async () => [tablet],
    })
    const { ConnectionsStore } = await import('@solus/workspace-ui/contexts/connections/connections.store.svelte')
    const store = new ConnectionsStore()

    await store.refreshServerMetadata('desk')

    expect(store.sessions).toEqual([])
    expect(store.pairedDevices).toEqual([tablet])
    expect(store.pairedDevicesError).toBeNull()
  })
})
