import { afterEach, describe, expect, test } from 'bun:test'

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
        }),
        connectionsListEndpoints: async () => [],
        connectionsListSessions: async () => [],
      } },
    })
    const { ConnectionsStore } = await import('../../src/renderer/contexts/connections/connections.store.svelte')
    const store = new ConnectionsStore()
    store.serverInfo = {
      installationId: 'test',
      remoteAccess: true,
      host: '0.0.0.0',
      port: 3000,
      allowLan: true,
      requireAuth: true,
    }

    const update = store.setRemoteAccess(false)

    expect(store.serverInfo.remoteAccess).toBe(false)
    expect(store.remoteAccessUpdating).toBe(true)

    finishRebind()
    await update
    expect(store.remoteAccessUpdating).toBe(false)
    expect(store.serverInfo.allowLan).toBe(false)
  })
})
