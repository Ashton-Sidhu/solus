import { afterEach, describe, expect, test } from 'bun:test'

const previousLocalStorage = globalThis.localStorage
const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousLocalStorage === undefined) {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: previousLocalStorage,
    })
  }
  if (previousWindow === undefined) {
    delete (globalThis as unknown as { window?: Window }).window
  } else {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: previousWindow,
    })
  }
  if (previousState === undefined) {
    delete (globalThis as unknown as { $state?: unknown }).$state
  } else {
    ;(globalThis as unknown as { $state: unknown }).$state = previousState
  }
})

describe('server removal', () => {
  test('requires switching away before forgetting the active host so the workspace is not reloaded', async () => {
    const values = new Map<string, string>([
      ['solus.activeServerId', 'remote'],
      ['solus.servers', JSON.stringify([{
        id: 'remote',
        label: 'Build Mac',
        url: 'http://build-mac:3000',
        sessionToken: 'token',
        installationId: 'build-mac',
        lastConnected: 1,
      }])],
    ])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size
      },
    } satisfies Storage
    let reloads = 0

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: storage,
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        location: { reload: () => { reloads++ } },
        // remove() fires a focus event; the mock must accept it regardless of
        // which test file initialized the shared runtime singleton first.
        dispatchEvent: () => true,
        matchMedia: (query: string) => ({
          matches: query === '(pointer: coarse)',
          addEventListener: () => {},
        }),
      },
    })
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

    const { serversStore } = await import('../../src/renderer/contexts/connections/servers.store.svelte')
    const { toasts } = await import('../../src/renderer/contexts/app/toast.store.svelte')
    // The store is a module singleton shared with other test files; align its
    // in-memory state with this file's fixtures regardless of import order.
    serversStore.refreshServers()
    serversStore.activeServerId = 'remote'
    const messages: string[] = []
    const originalError = toasts.error
    toasts.error = (message: string) => { messages.push(message) }
    try {
      serversStore.remove('remote')

      expect(reloads).toBe(0)
      expect(JSON.parse(storage.getItem('solus.servers') ?? '[]')).toHaveLength(1)
      expect(storage.getItem('solus.activeServerId')).toBe('remote')
      expect(messages).toEqual(['Switch to another host before forgetting Build Mac'])

      serversStore.activeServerId = 'local'
      serversStore.remove('remote')

      expect(reloads).toBe(0)
      expect(JSON.parse(storage.getItem('solus.servers') ?? '[]')).toHaveLength(0)
    } finally {
      toasts.error = originalError
    }
  })
})
