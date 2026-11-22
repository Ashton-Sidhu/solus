import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from '../helpers/bun-sqlite'
import type { Integration, IntegrationAuthChoice, IntegrationChangedEvent, IntegrationConnectionChangedEvent } from '@solus/contracts/integration-types'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { TEST_HANDLER_CTX } from '../helpers/handler-ctx'
import { resetTestDatabase } from '../helpers/test-db'
import { startFakeServers, type FakeServers } from './fake-servers'
import { memoryClients, memorySecretStore } from './memory-secrets'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { IntegrationOAuth } = await import('@solus/server/integrations/oauth')
const { IntegrationConnections } = await import('@solus/server/integrations/connections')
const { IntegrationConnectionStore } = await import('@solus/server/integrations/connection-store')
const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { IntegrationStore } = await import('@solus/server/integrations/integration-store')
const { IntegrationWrites } = await import('@solus/server/integrations/integration-create')
const { registerIntegrationHandlers } = await import('@solus/server/transport/handlers/integration-handlers')
const { SolusServer } = await import('@solus/server/transport/server')
const { Vault } = await import('@solus/server/vault/vault')
const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
const { ownerKeyOf } = await import('@solus/server/admission/actor')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_IDENTITY } = await import('@solus/server/execution/seats/acting-identity')
const { flushLogs, logFilePath } = await import('@solus/server/logger')
const { dataDir } = await import('@solus/server/platform/paths')
const db = await import('@solus/server/db')

/**
 * Add server (docs/plans/mcp-add-server.md): the authentication a person
 * chooses for a server at a URL, the OAuth scopes and client they give with it,
 * and the header values of a `headers` server. Against the loopback fake
 * servers: one that signs in with OAuth, and one that takes an `X-Api-Key`.
 */

const OWNER = ownerKeyOf(TEST_HANDLER_CTX.actor)!
const OWNER_SCOPE = { identity: HOST_IDENTITY, personKey: OWNER }
const KEY = 'k3y-value-9b2e'
const UNREACHABLE = 'http://127.0.0.1:1/mcp'

let fake: FakeServers

function setup() {
  const store = new IntegrationStore()
  const clients = memoryClients()
  const connectionStore = new IntegrationConnectionStore()
  const vault = new Vault({ secrets: memorySecretStore() })
  const connectionChanges: IntegrationConnectionChangedEvent[] = []
  const connectionEvents = { connectionChanged: (_person: string, event: IntegrationConnectionChangedEvent) => { connectionChanges.push(event) }, authFinished: () => undefined }
  const oauth = new IntegrationOAuth({ connections: connectionStore, integrations: store, vault, clients, events: connectionEvents })
  const connections = new IntegrationConnections({ store: connectionStore, integrations: store, vault, clients, oauth, events: connectionEvents })
  const gateway = new IntegrationGateway(store)
  gateway.useCredentials(connections)
  const changed: IntegrationChangedEvent[] = []
  const events = { broadcast: (_topic: string, event: IntegrationChangedEvent) => { changed.push(event); return 1 } } as never
  const server = new SolusServer()
  registerIntegrationHandlers(server, {
    store,
    catalog: {} as never,
    gateway,
    events,
    writes: new IntegrationWrites({ store, events, gateway, connections, oauth }),
    connectionStore,
    connections,
    oauth,
    getServerInfo: () => ({ host: '127.0.0.1', port: 4100 }),
    found: {} as never,
  })
  const handle = <T>(method: string, request: object): Promise<T> => withActingScope(OWNER_SCOPE, () => server.handle(method as never, [request] as never, TEST_HANDLER_CTX)) as Promise<T>
  const add = (url: string, auth?: IntegrationAuthChoice) => handle<Integration>('integrationCreate', auth ? { name: 'Server', url, auth } : { name: 'Server', url })
  const update = (request: object) => handle<Integration>('integrationUpdate', request)
  const stored = (id: string) => store.get(id, ANY_ORGANIZATION)
  return { store, clients, connectionStore, connections, connectionChanges, gateway, changed, handle, add, update, stored }
}

function context(): AgentToolContext {
  return { provider: 'claude-code', cwd: '/tmp', sessionId: () => undefined, abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => undefined }
}

beforeAll(async () => {
  fake = await startFakeServers()
})

afterEach(async () => {
  fake.options.anonymous = false
  fake.options.registration = true
  fake.acceptedKeys.clear()
  fake.keyedHeaders.length = 0
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir(), `solus.db${suffix}`), { force: true })
})

afterAll(async () => {
  db.closeDb()
  await fake.close()
})

describe('the authentication a person chooses', () => {
  test('an explicit choice adds a server the automatic probe refuses', async () => {
    // WHY: a server that takes its key in its own header names no sign-in the probe can read; the person knows how it signs in.
    const { add } = setup()
    await expect(add(fake.keyedMcpUrl)).rejects.toThrow('The server advertises a sign-in that Solus cannot use.')
    expect((await add(fake.keyedMcpUrl, { kind: 'headers', names: ['X-Api-Key'] })).auth).toEqual({ kind: 'headers', names: ['X-Api-Key'] })
    expect((await add(fake.keyedMcpUrl, { kind: 'none' })).auth).toEqual({ kind: 'none' })
  })

  test('a server the probe cannot reach is refused, whatever the choice', async () => {
    const { add, store } = setup()
    for (const auth of [{ kind: 'none' }, { kind: 'bearer' }, { kind: 'headers', names: ['X-Api-Key'] }] satisfies IntegrationAuthChoice[]) {
      await expect(add(UNREACHABLE, auth)).rejects.toThrow('Solus could not reach the server.')
    }
    expect(store.list(ANY_ORGANIZATION, OWNER)).toEqual([])
  })

  test('OAuth is refused for a server that offers none', async () => {
    const { add } = setup()
    await expect(add(fake.modernMcpUrl, { kind: 'oauth' })).rejects.toThrow('The server does not offer an OAuth sign-in.')
  })

  test('OAuth on a server that also works without it reads the registration from the metadata the server names', async () => {
    // WHY: the probe keeps only the address of an optional sign-in; the person who chose OAuth gets a record that can sign in.
    fake.options.anonymous = true
    const { add } = setup()
    expect((await add(fake.mcpUrl)).auth).toEqual({ kind: 'none', oauth: { discover: fake.resourceMetadataUrl } })
    expect((await add(fake.mcpUrl, { kind: 'oauth' })).auth).toEqual({ kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'dynamic' })
  })

  test('an API key on an OAuth server takes a Bearer key', async () => {
    const { add } = setup()
    expect((await add(fake.mcpUrl, { kind: 'bearer' })).auth).toEqual({ kind: 'bearer', scheme: 'bearer' })
  })

  test('the scopes go on the record, and the sign-in asks for them in place of the server\'s', async () => {
    const { add, handle } = setup()
    const start = async (id: string) => {
      const flow = await handle<{ kind: string; url: string }>('integrationConnectStart', { id, callbackBaseUrl: 'https://host.example' })
      return new URL(flow.url).searchParams.get('scope')
    }
    const plain = await add(fake.mcpUrl)
    expect(await start(plain.id)).toBe('read write')
    const scoped = await add(fake.mcpUrl, { kind: 'automatic', scopes: ['read'] })
    expect(scoped.auth).toMatchObject({ kind: 'oauth', scopes: ['read'] })
    expect(await start(scoped.id)).toBe('read')
  })

  test('the owner\'s client given with the add is saved, and its secret is not on the record', async () => {
    fake.options.registration = false
    const { add, clients, handle } = setup()
    const added = await add(fake.mcpUrl, { kind: 'oauth', client: { clientId: 'mine', clientSecret: 'mine-secret' } })
    expect(added.auth).toEqual({ kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required', clientId: 'mine', hasClientSecret: true })
    expect(JSON.stringify(added)).not.toContain('mine-secret')
    expect([...clients.clients.values()]).toContainEqual({ clientId: 'mine', clientSecret: 'mine-secret', tokenEndpointAuthMethod: 'client_secret_post', redirectUris: [] })
    const flow = await handle<{ url: string }>('integrationConnectStart', { id: added.id, callbackBaseUrl: 'https://host.example' })
    expect(new URL(flow.url).searchParams.get('client_id')).toBe('mine')
  })

  test('a client with automatic is not saved when the probe finds no OAuth', async () => {
    const { add, clients } = setup()
    const added = await add(fake.modernMcpUrl, { kind: 'automatic', client: { clientId: 'mine' } })
    expect(added.auth).toEqual({ kind: 'none' })
    expect(clients.clients.size).toBe(0)
  })
})

describe('changing the scopes and the header names', () => {
  test('the scopes of an OAuth server change, and null goes back to the server\'s', async () => {
    const { add, update, gateway } = setup()
    const added = await add(fake.mcpUrl, { kind: 'oauth', scopes: ['read'] })
    const invalidate = spyOn(gateway, 'invalidate')
    expect((await update({ id: added.id, scopes: ['write'] })).auth).toMatchObject({ scopes: ['write'] })
    // WHY: a session opened with a token for the old scopes must not stay in use.
    expect(invalidate).toHaveBeenCalledWith(added.id)
    expect((await update({ id: added.id, scopes: null })).auth).toEqual({ kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'dynamic' })
  })

  test('scopes and header names are refused on the wrong kind', async () => {
    const { add, update } = setup()
    const keyed = await add(fake.keyedMcpUrl, { kind: 'headers', names: ['X-Api-Key'] })
    const signed = await add(fake.mcpUrl)
    await expect(update({ id: keyed.id, scopes: ['read'] })).rejects.toThrow('does not sign in with OAuth, so it takes no scopes.')
    await expect(update({ id: signed.id, headerNames: ['X-Api-Key'] })).rejects.toThrow('does not take headers.')
  })

  test('new header names drop every person\'s saved values; the same names keep them', async () => {
    // WHY: a value saved for the old name must not go to the server under a name it was not given for.
    fake.acceptedKeys.add(KEY)
    const { add, update, handle, connections, connectionStore } = setup()
    const keyed = await add(fake.keyedMcpUrl, { kind: 'headers', names: ['X-Api-Key'] })
    await handle('integrationConnectSubmit', { id: keyed.id, values: [{ name: 'X-Api-Key', value: KEY }] })
    await update({ id: keyed.id, headerNames: ['X-Api-Key'] })
    expect(connections.headersFor(keyed.id, OWNER)).toEqual({ 'X-Api-Key': KEY })
    expect((await update({ id: keyed.id, headerNames: ['X-Token'] })).auth).toEqual({ kind: 'headers', names: ['X-Token'] })
    expect(connections.headersFor(keyed.id, OWNER)).toBeNull()
    expect(connectionStore.get(keyed.id, OWNER)).toBeNull()
  })
})

describe('the header values of a headers server', () => {
  test('the connect asks for one value for each header name', async () => {
    const { add, handle } = setup()
    const keyed = await add(fake.keyedMcpUrl, { kind: 'headers', names: ['X-Api-Key'] })
    expect(await handle('integrationConnectStart', { id: keyed.id })).toEqual({ kind: 'env', integrationId: keyed.id, accountId: 'default', names: ['X-Api-Key'] })
  })

  test('a set of names that is not the record\'s is refused, and nothing is saved', async () => {
    fake.acceptedKeys.add(KEY)
    const { add, handle, connections, connectionStore } = setup()
    const keyed = await add(fake.keyedMcpUrl, { kind: 'headers', names: ['X-Api-Key'] })
    await expect(handle('integrationConnectSubmit', { id: keyed.id, values: [{ name: 'X-Other', value: KEY }] })).rejects.toThrow('Give a value for X-Api-Key.')
    await expect(handle('integrationConnectSubmit', { id: keyed.id, values: [{ name: 'X-Api-Key', value: KEY }, { name: 'X-Other', value: KEY }] })).rejects.toThrow('and no other')
    expect(connections.headersFor(keyed.id, OWNER)).toBeNull()
    expect(connectionStore.get(keyed.id, OWNER)).toBeNull()
  })

  test('values the server refuses are not saved', async () => {
    const { add, handle, connections } = setup()
    const keyed = await add(fake.keyedMcpUrl, { kind: 'headers', names: ['X-Api-Key'] })
    await expect(handle('integrationConnectSubmit', { id: keyed.id, values: [{ name: 'X-Api-Key', value: 'wrong' }] })).rejects.toThrow('The server refused this credential.')
    expect(connections.headersFor(keyed.id, OWNER)).toBeNull()
  })

  test('the values go to the server on every request, and never into the record, the connection, or the log', async () => {
    fake.acceptedKeys.add(KEY)
    const { add, handle, gateway, connections, connectionStore, stored } = setup()
    const keyed = await add(fake.keyedMcpUrl, { kind: 'headers', names: ['X-Api-Key'] })
    await handle('integrationConnectSubmit', { id: keyed.id, values: [{ name: 'X-Api-Key', value: KEY }] })
    expect(connectionStore.get(keyed.id, OWNER)).toMatchObject({ status: 'connected', label: 'Fake MCP' })
    // WHY: a header server sends its own headers, not an Authorization header the gateway builds.
    expect(await connections.authorizationFor(keyed.id, OWNER)).toBeNull()

    fake.keyedHeaders.length = 0
    const result = await withActingScope(OWNER_SCOPE, () => gateway.call(keyed.id, 'echo', { text: 'hi' }, context(), null))
    expect(result).toEqual({ ok: true, text: 'hi' })
    expect(fake.keyedHeaders.length).toBeGreaterThan(0)
    expect(fake.keyedHeaders.every((header) => header === KEY)).toBe(true)

    expect(JSON.stringify(stored(keyed.id))).not.toContain(KEY)
    expect(JSON.stringify(connectionStore.list(OWNER))).not.toContain(KEY)
    flushLogs()
    expect(readFileSync(logFilePath(), 'utf8')).not.toContain(KEY)
  })

  test('a server that refuses the saved values marks the person as needing to give them again', async () => {
    fake.acceptedKeys.add(KEY)
    const { add, handle, gateway, connections, connectionStore } = setup()
    const keyed = await add(fake.keyedMcpUrl, { kind: 'headers', names: ['X-Api-Key'] })
    await handle('integrationConnectSubmit', { id: keyed.id, values: [{ name: 'X-Api-Key', value: KEY }] })
    fake.acceptedKeys.clear()
    const result = await withActingScope(OWNER_SCOPE, () => gateway.call(keyed.id, 'echo', { text: 'hi' }, context(), null))
    expect(result.text).toContain('CONNECTION_REQUIRED: Give the header values of Server')
    expect(connectionStore.get(keyed.id, OWNER)).toMatchObject({ status: 'needs-sign-in', error: 'Server refused the saved headers (HTTP 401). Give their values again.' })
    // The refused values are not sent again until the person gives new ones.
    expect(connections.headersFor(keyed.id, OWNER)).toBeNull()
    fake.acceptedKeys.add(KEY)
    await handle('integrationConnectSubmit', { id: keyed.id, values: [{ name: 'X-Api-Key', value: KEY }] })
    expect(connections.headersFor(keyed.id, OWNER)).toEqual({ 'X-Api-Key': KEY })
  })

  test('a disconnect removes the values', async () => {
    fake.acceptedKeys.add(KEY)
    const { add, handle, connections } = setup()
    const keyed = await add(fake.keyedMcpUrl, { kind: 'headers', names: ['X-Api-Key'] })
    await handle('integrationConnectSubmit', { id: keyed.id, values: [{ name: 'X-Api-Key', value: KEY }] })
    expect(await handle('integrationDisconnect', { id: keyed.id })).toEqual({ disconnected: true })
    expect(connections.headersFor(keyed.id, OWNER)).toBeNull()
  })
})
