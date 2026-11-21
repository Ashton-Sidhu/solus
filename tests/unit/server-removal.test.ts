import { afterEach, describe, expect, mock, test } from 'bun:test'
import { localStorageCredentials } from '@solus/client-core/host-credentials'
import { pairPageHosts } from './helpers/page-host-catalog'

mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))
mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({
  notificationsStore: { wants: () => false },
}))

const previousLocalStorage = globalThis.localStorage
const previousWindow = globalThis.window
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
  else Reflect.deleteProperty(globalThis, 'document')
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
  test('forgetting the last host refuses; a non-default host forgets in place', async () => {
    // WHY: dispatch-client step 5 — removal never reloads. The active host is
    // only the new-work default, so removing it steps aside to another
    // catalog host; only the last host has nowhere to step to.
    const values = new Map<string, string>([['solus.activeServerId', 'remote']])
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
        addEventListener: () => {},
        removeEventListener: () => {},
        matchMedia: (query: string) => ({
          matches: query === '(pointer: coarse)',
          addEventListener: () => {},
        }),
      },
    })
    // The shared runtime singleton toggles a viewport class at import time.
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: {
        documentElement: { classList: { toggle: () => {} } },
        addEventListener: () => {},
        removeEventListener: () => {},
        visibilityState: 'visible',
        hasFocus: () => true,
      },
    })
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

    const { serversStore } = await import('@solus/workspace-ui/contexts/connections/servers.store.svelte')
    const { toasts } = await import('@solus/workspace-ui/lib/toasts')
    const { serverConnections } = await import('@solus/client-core/server-connections')
    const { hostCatalog } = await import('@solus/client-core/host-catalog')
    // The catalog is a module singleton shared with other test files; this file
    // pairs its own host regardless of import order.
    const list = await pairPageHosts([{
      id: 'remote',
      label: 'Build Mac',
      routes: [{ kind: 'lan', url: 'http://build-mac:3000', source: 'pairing', seenAt: 1 }],
      sessionToken: 'token',
      installationId: 'build-mac',
      lastConnected: 1,
    }])
    const credentialIds = async () => [...(await localStorageCredentials().read()).keys()]
    serversStore.activeServerId = 'remote'
    const messages: string[] = []
    const originalError = toasts.error
    toasts.error = (message: string) => { messages.push(message) }
    try {
      await serversStore.remove('remote')

      expect(reloads).toBe(0)
      expect(await credentialIds()).toEqual(['remote'])
      expect([...list.state.listings.keys()]).toEqual(['remote'])
      expect(storage.getItem('solus.activeServerId')).toBe('remote')
      expect(messages).toEqual(['Pair another host before forgetting Build Mac'])

      serversStore.activeServerId = 'local'
      // A tab on the host retains its connection. Forget must still take the
      // host off the list, or its page stays open and the click does nothing.
      serverConnections.ensure('remote')
      serverConnections.retain('remote')
      await serversStore.remove('remote')

      expect(reloads).toBe(0)
      // Off the person's list, then this device's credential (plans/033 §4.1).
      expect([...list.state.listings.keys()]).toEqual([])
      expect(await credentialIds()).toEqual([])
      expect(hostCatalog.find('remote')).toBeUndefined()
      expect(serversStore.servers.map((server) => server.id)).not.toContain('remote')
    } finally {
      toasts.error = originalError
    }
  })
})
