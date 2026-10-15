import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Integration, IntegrationAuthFinishedEvent, IntegrationConnectionChangedEvent } from '@solus/contracts/integration-types'
import { resetTestDatabase } from '../helpers/test-db'
import { startFakeServers, type FakeServers } from './fake-servers'
import { memoryClients, memorySecretStore } from './memory-secrets'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { IntegrationOAuth } = await import('@solus/server/integrations/oauth')
const { IntegrationConnections } = await import('@solus/server/integrations/connections')
const { IntegrationConnectionStore } = await import('@solus/server/integrations/connection-store')
const { Vault, mcpCredentialRef } = await import('@solus/server/vault/vault')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_IDENTITY } = await import('@solus/server/execution/seats/acting-identity')
const { dataDir } = await import('@solus/server/platform/paths')
const db = await import('@solus/server/db')

/**
 * Per-person OAuth sign-in (docs/plans/mcp-integrations.md §4.3) against a fake
 * authorization server and MCP server on a loopback port: discovery from
 * resource metadata, one registration reused, PKCE and `resource`, the token
 * stored for the person who started, refresh, and the paste path.
 */

const ALICE = { identity: HOST_IDENTITY, personKey: 'account:alice' }
const BOB = { identity: HOST_IDENTITY, personKey: 'account:bob' }
const START = { callbackBaseUrl: 'https://host.example', fallbackHost: '127.0.0.1', fallbackPort: 4100 }

let fake: FakeServers
let integration: Integration

function setup(now = () => Date.now()) {
  const store = new IntegrationConnectionStore()
  const secrets = memorySecretStore()
  const vault = new Vault({ secrets })
  const clients = memoryClients()
  /** The access token the vault holds on this host for a person. */
  const hostToken = async (personKey: string) => {
    const credential = await vault.read(personKey, mcpCredentialRef(integration))
    return credential?.location === 'host' ? credential.token.accessToken : undefined
  }
  const changed: Array<{ user: string; event: IntegrationConnectionChangedEvent }> = []
  const finished: Array<{ user: string; event: IntegrationAuthFinishedEvent }> = []
  const events = {
    connectionChanged: (user: string, event: IntegrationConnectionChangedEvent) => { changed.push({ user, event }) },
    authFinished: (user: string, event: IntegrationAuthFinishedEvent) => { finished.push({ user, event }) },
  }
  const integrations = { get: (id: string) => (id === integration.id ? integration : null) }
  const oauth = new IntegrationOAuth({ connections: store, integrations, vault, clients, events, now })
  const connections = new IntegrationConnections({ store, integrations, vault, clients, oauth, events })
  return { hostToken, store, oauth, connections, changed, finished }
}

/** What the authorization server would send the browser back with, for this authorization URL. */
function approve(url: string): URLSearchParams {
  const auth = new URL(url).searchParams
  const code = fake.issueCode(auth.get('code_challenge') ?? '', auth.get('resource'), auth.get('redirect_uri'))
  return new URLSearchParams({ code, state: auth.get('state') ?? '' })
}

async function startAs(scope: typeof ALICE, oauth: InstanceType<typeof IntegrationOAuth>, options = START) {
  const result = await withActingScope(scope, () => oauth.start(integration, options))
  if (result.kind !== 'waiting') throw new Error(`expected waiting, got ${result.kind}`)
  return result
}

beforeAll(async () => {
  fake = await startFakeServers()
  integration = {
    id: 'int-oauth',
    organizationId: 'local',
    ownerKey: 'local:test',
    kind: 'mcp',
    slug: 'fake',
    name: 'Fake',
    url: fake.mcpUrl,
    auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'dynamic' },
    createdBy: null,
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
  }
})

afterEach(async () => {
  fake.options.registration = true
  fake.options.refuseRefresh = false
  fake.options.expiresIn = 3600
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir(), `solus.db${suffix}`), { force: true })
})

afterAll(async () => {
  db.closeDb()
  await fake.close()
})

describe('integration OAuth', () => {
  test('discovers from resource metadata and builds an S256 authorization URL bound to the server', async () => {
    const { oauth } = setup()
    const result = await startAs(ALICE, oauth)
    const url = new URL(result.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.base}/as/authorize`)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // WHY (RFC 8707): the token's audience must be the integration's server, not any resource of the issuer.
    expect(url.searchParams.get('resource')).toBe(integration.url)
    expect(url.searchParams.get('scope')).toBe('read write')
    expect(url.searchParams.get('redirect_uri')).toBe('https://host.example/oauth/integration/callback')
    expect(result.input).toBe('callback')
  })

  test('registers a client once and reuses it for the next sign-in', async () => {
    const { oauth } = setup()
    const before = fake.registrations.length
    await startAs(ALICE, oauth)
    await startAs(BOB, oauth)
    // WHY: a registration belongs to the host per integration; one per sign-in would flood the server.
    expect(fake.registrations.length - before).toBe(1)
    expect(fake.registrations.at(-1)).toMatchObject({ redirect_uris: ['https://host.example/oauth/integration/callback'], token_endpoint_auth_method: 'none' })
  })

  test('the callback stores the token for the person who started, and another person cannot use it', async () => {
    const { oauth, connections, store, changed, finished } = setup()
    const flow = await startAs(ALICE, oauth)
    const page = await oauth.complete(approve(flow.url))
    expect(page.status).toBe(200)
    // The callback carries no principal: the flow's scope decides whose token it is.
    const alice = await connections.authorizationFor(integration.id, ALICE.personKey)
    expect(alice).toMatch(/^Bearer access-/)
    expect(await connections.authorizationFor(integration.id, BOB.personKey)).toBeNull()
    expect(await connections.authorizationFor(integration.id, 'local:owner')).toBeNull()
    expect(store.get(integration.id, ALICE.personKey)).toMatchObject({ status: 'connected', label: 'Fake MCP' })
    expect(changed.map((each) => each.user)).toEqual([ALICE.personKey])
    expect(finished).toEqual([{ user: ALICE.personKey, event: { flowId: flow.flowId, integrationId: integration.id, outcome: 'connected' } }])
    // The token exchange carried the verifier and the resource.
    const exchange = fake.tokenRequests.at(-1)
    expect(exchange?.get('code_verifier')).toBeTruthy()
    expect(exchange?.get('resource')).toBe(integration.url)
  })

  test('a pasted redirect address completes the same as a callback, for its own person only', async () => {
    const { oauth, connections } = setup()
    const flow = await startAs(ALICE, oauth, { fallbackHost: '127.0.0.1', fallbackPort: 4100 })
    expect(flow.input).toBe('redirect-url')
    const pasted = `http://127.0.0.1:4100/oauth/integration/callback?${approve(flow.url)}`
    // WHY: a flow id is not a credential; another person cannot finish someone else's sign-in.
    await expect(withActingScope(BOB, () => oauth.submitRedirect(flow.flowId, pasted))).rejects.toThrow(/expired/)
    await withActingScope(ALICE, () => oauth.submitRedirect(flow.flowId, pasted))
    expect(await connections.authorizationFor(integration.id, ALICE.personKey)).toMatch(/^Bearer access-/)
  })

  test('an expired flow fails plainly', async () => {
    let now = Date.now()
    const { oauth, finished } = setup(() => now)
    const flow = await startAs(ALICE, oauth)
    const params = approve(flow.url)
    now += 11 * 60_000
    await expect(withActingScope(ALICE, () => oauth.submitRedirect(flow.flowId, `https://host.example/oauth/integration/callback?${params}`))).rejects.toThrow('This sign-in expired. Start it again.')
    expect(finished.at(-1)?.event.outcome).toBe('failed')
  })

  test('a token with under a minute left is refreshed before use', async () => {
    fake.options.expiresIn = 30
    const { oauth, connections, hostToken } = setup()
    const flow = await startAs(ALICE, oauth)
    await oauth.complete(approve(flow.url))
    const first = await hostToken(ALICE.personKey)
    fake.options.expiresIn = 3600
    const header = await connections.authorizationFor(integration.id, ALICE.personKey)
    expect(fake.tokenRequests.at(-1)?.get('grant_type')).toBe('refresh_token')
    expect(header).not.toBe(`Bearer ${first}`)
    expect(header).toBe(`Bearer ${await hostToken(ALICE.personKey)}`)
  })

  test('a refused refresh marks the connection needs-sign-in', async () => {
    fake.options.expiresIn = 30
    const { oauth, connections, store, changed } = setup()
    const flow = await startAs(ALICE, oauth)
    await oauth.complete(approve(flow.url))
    fake.options.refuseRefresh = true
    expect(await connections.authorizationFor(integration.id, ALICE.personKey)).toBeNull()
    expect(store.get(integration.id, ALICE.personKey)?.status).toBe('needs-sign-in')
    expect(changed.at(-1)?.event.connection?.status).toBe('needs-sign-in')
  })

  test('without registration or an administrator client, the sign-in says so', async () => {
    fake.options.registration = false
    const { oauth } = setup()
    const other: Integration = { ...integration, id: 'int-no-client', auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required' } }
    await expect(withActingScope(ALICE, () => oauth.start(other, START))).rejects.toThrow('This server needs an OAuth client. Its owner adds one in the server settings.')
  })

  test('disconnect removes the token and revokes it at the server', async () => {
    const { oauth, connections, store, changed } = setup()
    const flow = await startAs(ALICE, oauth)
    await oauth.complete(approve(flow.url))
    expect(await connections.disconnect(integration, ALICE.personKey)).toBe(true)
    expect(await connections.authorizationFor(integration.id, ALICE.personKey)).toBeNull()
    expect(store.get(integration.id, ALICE.personKey)).toBeNull()
    expect(changed.at(-1)?.event.connection).toBeNull()
    expect(fake.revoked.at(-1)).toMatch(/^refresh-/)
  })
})
