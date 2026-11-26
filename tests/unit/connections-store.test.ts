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

describe('paired devices on Sharing & access', () => {
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

describe('outside apps on Sharing & access', () => {
  function useState() {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
  }

  const SOLUS = { source: 'solus' as const, url: 'https://box.solus.dev/mcp', reach: 'internet' as const }
  const endpoint = (port: number, addresses: { source: 'solus'; url: string; reach: 'internet' }[] = []) => ({ localUrl: `http://localhost:${port}/mcp`, publicUrl: addresses[0]?.url ?? null, addresses })

  test('each host keeps its own addresses, and an older read never overwrites a newer one', async () => {
    useState()
    const answers: ((value: ReturnType<typeof endpoint>) => void)[] = []
    mockedServerConnections.registerHost('slow', {
      connectionsAppEndpoint: () => new Promise((resolve) => { answers.push(resolve) }),
    })
    mockedServerConnections.registerHost('other', {
      connectionsAppEndpoint: async () => endpoint(2),
    })
    const { ConnectionsStore } = await import('@solus/workspace-ui/contexts/connections/connections.store.svelte')
    const store = new ConnectionsStore()

    const olderRead = store.loadAppEndpoint('slow')
    const newerRead = store.loadAppEndpoint('slow')
    await store.loadAppEndpoint('other')
    answers[1]!(endpoint(1, [SOLUS]))
    await newerRead
    answers[0]!(endpoint(1))
    await olderRead

    expect(store.appEndpointFor('slow')).toEqual(endpoint(1, [SOLUS]))
    // The dialog and Sharing & access may show two hosts: one host's read never shows on the other.
    expect(store.appEndpointFor('other')).toEqual(endpoint(2))
    // A host with no Tailscale (the mock has no such method) reads as "Tailscale did not answer", not as an error.
    expect(store.appTailscaleFor('other')).toBeNull()
  })

  test('a test is kept with the url it tested, and Check again forgets it', async () => {
    useState()
    let answerTest!: (result: { reachable: boolean; reason: string | null }) => void
    mockedServerConnections.registerHost('box', {
      connectionsAppEndpoint: async () => endpoint(1, [SOLUS]),
      connectionsTestAppAddress: () => new Promise((resolve) => { answerTest = resolve }),
    })
    const { ConnectionsStore } = await import('@solus/workspace-ui/contexts/connections/connections.store.svelte')
    const store = new ConnectionsStore()
    await store.loadAppEndpoint('box')

    const test = store.testAppAddress('box', 'solus')
    expect(store.appAddressTestsFor('box').solus).toEqual({ kind: 'running', url: SOLUS.url })
    answerTest({ reachable: false, reason: 'hairpin' })
    await test
    expect(store.appAddressTestsFor('box').solus).toMatchObject({ kind: 'done', url: SOLUS.url, reachable: false, reason: 'hairpin' })

    store.forgetAppAddressTests('box')
    expect(store.appAddressTestsFor('box')).toEqual({})
    // An address the host does not list is not tested.
    await store.testAppAddress('box', 'custom')
    expect(store.appAddressTestsFor('box')).toEqual({})
  })

  test('a refused pairing code says why, and another host starts with no code', async () => {
    useState()
    mockedServerConnections.registerHost('locked', {
      connectionsCreateAppPairingCode: async () => { throw new Error('A policy turns off remote access') },
    })
    mockedServerConnections.registerHost('open', {
      connectionsCreateAppPairingCode: async () => ({ code: '123456', access: 'write', expiresAt: 10 }),
    })
    const { ConnectionsStore } = await import('@solus/workspace-ui/contexts/connections/connections.store.svelte')
    const store = new ConnectionsStore()

    await store.createAppPairingCode('open', 'write')
    expect(store.appPairingCodeFor('open')).toEqual({ code: '123456', access: 'write', expiresAt: 10 })
    expect(store.appPairingCodeFor('locked')).toBeNull()

    await store.createAppPairingCode('locked', 'write')
    expect(store.appPairingCodeFor('locked')).toBeNull()
    expect(store.appPairingCodeFor('open')).toBeNull()
    expect(store.appPairingCodeErrorFor('locked')).toBe('A policy turns off remote access')
    expect(store.appPairingCodeErrorFor('open')).toBeNull()
    expect(store.appPairingCodeCreating).toBe(false)
  })
})
