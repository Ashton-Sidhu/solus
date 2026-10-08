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

async function newStore() {
  testGlobal.$state = <T>(value: T) => value
  // `subscribeAllHosts` only attaches to hosts the registry knows about.
  mockedServerConnections.registerHost('studio', {})
  const { ConnectRequestStore } = await import(
    '@solus/workspace-ui/contexts/connections/connect-request.store.svelte'
  )
  return new ConnectRequestStore()
}

test('a connect request stays with the session and host that raised it', async () => {
  // The card belongs to the conversation that is waiting. Showing it on another
  // tab would interrupt work that never asked for the account.
  const store = await newStore()
  const unsubscribe = store.listen()

  mockedServerConnections.emit('studio', 'connection.connectNeeded', {
    provider: 'atlassian',
    reason: 'jira',
    sessionId: 'requesting-session',
  })

  expect(store.visibleFor('studio', 'requesting-session')).toBe(true)
  expect(store.visibleFor('studio', 'active-session')).toBe(false)
  expect(store.visibleFor('laptop', 'requesting-session')).toBe(false)

  unsubscribe()
})

test('the request carries which account is missing and what it is for', async () => {
  // Confluence and Jira are one Atlassian grant, so the provider cannot say
  // which product the user asked about — the reason has to.
  const store = await newStore()
  const unsubscribe = store.listen()

  mockedServerConnections.emit('studio', 'connection.connectNeeded', {
    provider: 'atlassian',
    reason: 'confluence',
    sessionId: 'session-a',
  })

  expect(store.request).toEqual({
    kind: 'account',
    serverId: 'studio',
    sessionId: 'session-a',
    provider: 'atlassian',
    reason: 'confluence',
  })

  unsubscribe()
})

test('an integration that needs the caller to sign in raises the same card for its session', async () => {
  // An integration tool answered CONNECTION_REQUIRED (mcp-integrations.md §4.1
  // rule 2): the card names the integration, not an account provider.
  const store = await newStore()
  const unsubscribe = store.listen()

  mockedServerConnections.emit('studio', 'integration.connectNeeded', {
    integrationId: 'int-linear',
    integrationName: 'Linear',
    sessionId: 'session-a',
  })

  expect(store.request).toEqual({
    kind: 'integration',
    serverId: 'studio',
    sessionId: 'session-a',
    integrationId: 'int-linear',
    integrationName: 'Linear',
  })
  expect(store.visibleFor('studio', 'session-b')).toBe(false)

  unsubscribe()
})

test('a dismissal retires the card without waiting for the agent', async () => {
  const store = await newStore()
  const unsubscribe = store.listen()

  mockedServerConnections.emit('studio', 'connection.connectNeeded', {
    provider: 'github',
    reason: 'pull-requests',
    sessionId: 'session-a',
  })
  store.dismiss()

  expect(store.request).toBeNull()
  expect(store.visibleFor('studio', 'session-a')).toBe(false)

  unsubscribe()
})
