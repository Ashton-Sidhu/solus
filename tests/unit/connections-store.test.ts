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
          return { remoteAccess: false, host: '127.0.0.1', port: 3000, allowLan: false, requireAuth: false }
        },
        connectionsGetServerInfo: async () => ({
          installationId: 'test',
          remoteAccess: false,
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
      remoteAccess: true,
      host: '0.0.0.0',
      port: 3000,
      allowLan: true,
      requireAuth: true,
      trustLocalNetwork: false,
      hostKind: 'personal',
    }

    const update = store.setRemoteAccess('local', false)

    expect(store.serverInfo.remoteAccess).toBe(false)
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
