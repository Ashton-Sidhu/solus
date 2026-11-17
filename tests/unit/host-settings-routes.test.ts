import { beforeEach, expect, mock, test } from 'bun:test'
import type { HostFact } from '@solus/client-core/host-facts'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { LOCAL_SERVER_ID, type SavedServer } from '@solus/client-core/server-registry'

// The desktop's own host is not in the saved remote registry. Its routes must
// come from server info, so a user can find an address to use on another device.
const servers = {
  local: { installationId: 'this-mac' },
  remotes: [] as SavedServer[],
  servers: [] as SavedServer[],
  readinessFor: () => ({ readiness: 'ready' }),
}
let fact: HostFact<Pick<ConnectionsServerInfo, 'routes'>> = { state: 'loading' }
mock.module('../../packages/workspace-ui/src/contexts/index.ts', () => ({ serversStore: servers }))
mock.module('../../packages/workspace-ui/src/contexts/hosts/hosts.svelte.ts', () => ({
  hosts: { get: () => ({ get serverInfo() { return fact } }) },
}))
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: { dialedUrl: () => 'http://studio.local:3000' },
}))
const { hostRoutesStore } = await import('../../packages/workspace-ui/src/components/connections/host-routes.store.svelte')

beforeEach(() => {
  servers.servers = []
  servers.remotes = []
  fact = { state: 'loading' }
})

test('this computer shows advertised addresses without remote route controls', () => {
  fact = { state: 'ready', value: { routes: [{ kind: 'lan', url: 'http://192.168.1.8:3000', source: 'host' }] } }
  expect(hostRoutesStore.rowsFor(LOCAL_SERVER_ID).map((row) => row.url)).toEqual(['http://192.168.1.8:3000'])
  expect(hostRoutesStore.canChange(LOCAL_SERVER_ID)).toBe(false)
  expect(hostRoutesStore.rowsFor(LOCAL_SERVER_ID)[0]?.canRemove).toBe(false)
  expect(hostRoutesStore.inUseFor(LOCAL_SERVER_ID)).toBeNull()
})

test('loading and a failed read do not claim that this computer has no routes', () => {
  expect(hostRoutesStore.localRoutesStatus(LOCAL_SERVER_ID)).toContain('Reading')
  fact = { state: 'error', message: 'Disconnected' }
  expect(hostRoutesStore.localRoutesStatus(LOCAL_SERVER_ID)).toContain('Could not read')
  fact = { state: 'ready', value: { routes: [] } }
  expect(hostRoutesStore.localRoutesStatus(LOCAL_SERVER_ID)).toBeNull()
})

test('a remote host keeps its saved routes and its current route while metadata loads', () => {
  servers.remotes = [{ id: 'studio', installationId: 'studio', label: 'Studio', lastConnected: 1, routes: [{ kind: 'lan', url: 'http://studio.local:3000', source: 'pairing' }] }]
  expect(hostRoutesStore.rowsFor('studio').map((row) => row.url)).toEqual(['http://studio.local:3000'])
  expect(hostRoutesStore.canChange('studio')).toBe(true)
  expect(hostRoutesStore.inUseFor('studio')).toBe('http://studio.local:3000')
  expect(hostRoutesStore.rowsFor('removed')).toEqual([])
  expect(hostRoutesStore.canChange('removed')).toBe(false)
})

test('a web origin host shows its routes even when it is not a saved remote', () => {
  servers.servers = [{ id: 'origin', installationId: 'origin', label: 'Origin', lastConnected: 1, routes: [{ kind: 'public', url: 'https://host.example.com', source: 'page' }] }]
  expect(hostRoutesStore.rowsFor('origin').map((row) => row.url)).toEqual(['https://host.example.com'])
  expect(hostRoutesStore.canChange('origin')).toBe(false)
  expect(hostRoutesStore.rowsFor('origin')[0]?.canRemove).toBe(false)
})
