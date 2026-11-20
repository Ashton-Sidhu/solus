import { describe, expect, test } from 'bun:test'

const values = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  } satisfies Storage,
})

;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

const { hostCatalog } = await import('@solus/client-core/host-catalog')
const { pairPageHosts } = await import('./helpers/page-host-catalog')
const { connectionsNav } = await import('@solus/workspace-ui/components/connections/connections-nav.svelte')

describe('connections page', () => {
  test('forgetting the host whose page is open returns to the list', async () => {
    // WHY: the page resolves its host from the live list, so a page left on a
    // forgotten id opens again as soon as that host is listed again.
    await pairPageHosts([{ id: 'omarchy', label: 'omarchy', routes: [{ kind: 'lan', url: 'http://10.10.1.79:3000', source: 'pairing', seenAt: 1 }], sessionToken: 'token', installationId: 'omarchy', lastConnected: 1 }])
    connectionsNav.open('omarchy')
    await hostCatalog.forget('omarchy')
    expect(connectionsNav.hostId).toBeNull()
  })
})
