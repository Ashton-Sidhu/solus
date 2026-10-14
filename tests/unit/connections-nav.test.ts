import { describe, expect, test } from 'bun:test'

const values = new Map<string, string>([
  ['solus.servers', JSON.stringify([{ id: 'omarchy', label: 'omarchy', url: 'http://10.10.1.79:3000', sessionToken: 'token', installationId: 'omarchy', lastConnected: 1 }])],
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
    get length() { return values.size },
  } satisfies Storage,
})

;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

const { removeServer } = await import('@solus/client-core/server-registry')
const { connectionsNav } = await import('@solus/workspace-ui/components/connections/connections-nav.svelte')

describe('connections page', () => {
  test('forgetting the host whose page is open returns to the list', () => {
    // WHY: the page resolves its host from the live list, so a page left on a
    // forgotten id opens again as soon as that host is listed again.
    connectionsNav.open('omarchy')
    removeServer('omarchy')
    expect(connectionsNav.hostId).toBeNull()
  })
})
