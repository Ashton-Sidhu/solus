import { afterAll, describe, expect, mock, test } from 'bun:test'
import { answerPageDirectory, answerPageList, directoryAccount } from './helpers/page-host-catalog'
import { listingFor } from './helpers/host-catalog-world'

// WHY: the organization's workspace service is a cloud service the records
// live in — one service, every organization scoped by its grant — never a host
// (docs/plans/workspace-and-machines.md §4). The client holds a connection to
// it per organization, and the moment that connection is listed as a host, the
// person sees a "machine" named after their organization in Connections, in the
// Run-on picker, and on every badge. `servers` is the machines alone; the
// connection is kept in its own registry and reachable only by id.

mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', info: () => '', dismiss: () => {} }) }))

const previousLocalStorage = globalThis.localStorage
const previousState = (globalThis as unknown as { $state?: unknown }).$state

const values = new Map<string, string>([['solus.activeServerId', 'local']])

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
// The person's list names one machine; the directory lists the organization's workspace service.
await answerPageList([listingFor('remote', { label: 'Build host', installationId: 'build-host', routes: [{ kind: 'lan', url: 'http://10.10.1.22:3000', source: 'pairing', seenAt: 1 }] })])
await answerPageDirectory(directoryAccount([], [{
  organizationId: 'org-1',
  label: 'eng',
  routes: [{ kind: 'tunnel', url: 'https://workspace.solus.sh' }],
  isActive: true,
  hostRules: { allowPersonalHosts: true },
}]))

afterAll(() => {
  if (previousLocalStorage === undefined) {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previousLocalStorage })
  }
  if (previousState === undefined) {
    delete (globalThis as unknown as { $state?: unknown }).$state
  } else {
    ;(globalThis as unknown as { $state: unknown }).$state = previousState
  }
})

describe('the workspace service connection', () => {
  test('is not among the hosts, only among the cloud connections', () => {
    expect(serversStore.servers.map((server) => server.id)).toEqual(['remote'])
    expect(serversStore.cloudConnections.map((server) => server.id)).toEqual(['workspace:org-1'])
    expect(serversStore.activeCloudServerId).toBe('workspace:org-1')
  })

  test('still answers by id, so a record that lives there names its home', () => {
    expect(serversStore.cloudHomeLabel('workspace:org-1')).toBe('Solus Cloud')
    expect(serversStore.hostFor('workspace:org-1')?.label).toBe('eng')
  })

  test('wears no machine badge', () => {
    expect(serversStore.affinityFor('workspace:org-1')).toBeNull()
  })
})
