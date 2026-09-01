import { afterEach, expect, mock, test } from 'bun:test'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const mockedServerConnections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: mockedServerConnections,
}))

type TestGlobal = typeof globalThis & { $state?: unknown }

// SAFETY: This test installs the Svelte rune shim on the test process global and restores it after each case.
const testGlobal = globalThis as TestGlobal
const previousState = testGlobal.$state

afterEach(() => {
  mockedServerConnections.reset()
  if (previousState === undefined) delete testGlobal.$state
  else testGlobal.$state = previousState
})

test('Cloudflare status follows the host selected in settings', async () => {
  testGlobal.$state = <T>(value: T) => value
  mockedServerConnections.registerHost('laptop', {
    cloudflareStatus: async () => ({ connected: true, accountName: 'Laptop account' }),
  })
  mockedServerConnections.registerHost('studio', {
    cloudflareStatus: async () => ({ connected: true, accountName: 'Studio account' }),
  })
  const { CloudflareStore } = await import('@solus/workspace-ui/contexts/cloudflare/cloudflare.store.svelte')
  const store = new CloudflareStore()

  await store.ensureStatus('studio')
  expect(store.accountName).toBe('Studio account')

  await store.ensureStatus('laptop')
  expect(store.accountName).toBe('Laptop account')
})
