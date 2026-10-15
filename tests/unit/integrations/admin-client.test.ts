import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { IntegrationChangedEvent } from '@solus/contracts/integration-types'
import type { Principal } from '@solus/server/admission/principal'
import { TEST_HANDLER_CTX } from '../helpers/handler-ctx'
import { resetTestDatabase } from '../helpers/test-db'
import { installTestIdentities } from '../helpers/acting-identities'
import { startFakeServers, type FakeServers } from './fake-servers'
import { memoryClients, memorySecretStore } from './memory-secrets'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { IntegrationOAuth } = await import('@solus/server/integrations/oauth')
const { IntegrationConnectionStore } = await import('@solus/server/integrations/connection-store')
const { Vault } = await import('@solus/server/vault/vault')
const { IntegrationStore } = await import('@solus/server/integrations/integration-store')
const { registerIntegrationHandlers } = await import('@solus/server/transport/handlers/integration-handlers')
const { SolusServer } = await import('@solus/server/transport/server')
const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
const { actorFor, ownerKeyOf } = await import('@solus/server/admission/actor')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_IDENTITY } = await import('@solus/server/execution/seats/acting-identity')
const { dataDir } = await import('@solus/server/platform/paths')
const db = await import('@solus/server/db')

/**
 * The owner's OAuth client (docs/plans/mcp-integrations.md §4.3, phase 3;
 * docs/plans/access-model.md D3): a server with no dynamic registration (Zoom)
 * signs in only with a client its owner saved through `integrationUpdate`. The
 * secret stays on the host: the record says only that one is stored.
 */

const ALICE = { identity: HOST_IDENTITY, personKey: 'account:alice' }
const START = { callbackBaseUrl: 'https://host.example', fallbackHost: '127.0.0.1', fallbackPort: 4100 }

let fake: FakeServers

function setup() {
  const secrets = memoryClients()
  const store = new IntegrationStore()
  const events = { connectionChanged: () => undefined, authFinished: () => undefined }
  const connections = new IntegrationConnectionStore()
  const vault = new Vault({ secrets: memorySecretStore() })
  const oauth = new IntegrationOAuth({ connections, integrations: store, vault, clients: secrets, events })
  const server = new SolusServer()
  const changed: IntegrationChangedEvent[] = []
  const invalidated: string[] = []
  registerIntegrationHandlers(server, {
    store,
    catalog: {} as never,
    gateway: { invalidate: (id: string) => { invalidated.push(id) }, warm: async () => undefined } as never,
    events: { broadcast: (_topic: string, event: IntegrationChangedEvent) => { changed.push(event); return 1 } } as never,
    connectionStore: {} as never,
    connections: {} as never,
    oauth,
    clients: secrets,
    getServerInfo: () => ({ host: '127.0.0.1', port: 4100 }),
  })
  const integration = store.create(
    { name: 'Zoom', url: fake.mcpUrl, slug: 'zoom', auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required' } },
    'local',
    ownerKeyOf(TEST_HANDLER_CTX.actor)!,
  )
  const update = (oauthClient: { clientId: string; clientSecret?: string } | null) =>
    server.handle('integrationUpdate', [{ id: integration.id, oauthClient }], TEST_HANDLER_CTX)
  const start = () => withActingScope(ALICE, () => oauth.start(store.get(integration.id, ANY_ORGANIZATION) ?? integration, START))
  const updateAs = (principal: Principal, oauthClient: { clientId: string }) =>
    server.handle('integrationUpdate', [{ id: integration.id, oauthClient }], { clientId: 'other', principal, actor: actorFor(principal) })
  return { secrets, store, oauth, integration, update, updateAs, start, changed, invalidated }
}

beforeAll(async () => {
  fake = await startFakeServers()
})

afterEach(async () => {
  fake.options.registration = true
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir(), `solus.db${suffix}`), { force: true })
})

afterAll(async () => {
  db.closeDb()
  await fake.close()
})

describe('the owner\'s OAuth client', () => {
  test('without registration or a saved client, the sign-in refuses plainly', async () => {
    fake.options.registration = false
    const { start } = setup()
    await expect(start()).rejects.toThrow('This server needs an OAuth client. Its owner adds one in the server settings.')
  })

  test('a saved client with a secret signs in and sends the secret as client_secret_post', async () => {
    fake.options.registration = false
    const { update, start, oauth, secrets, integration, changed, invalidated } = setup()
    const before = fake.registrations.length
    const updated = await update({ clientId: 'zoom-client', clientSecret: 'zoom-secret' })
    // WHY: the record crosses the wire; it may say a secret exists but never carry it.
    expect(updated.auth).toEqual({ kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required', clientId: 'zoom-client', hasClientSecret: true })
    expect(JSON.stringify(updated)).not.toContain('zoom-secret')
    expect(secrets.clients.get(integration.id)).toEqual({ clientId: 'zoom-client', clientSecret: 'zoom-secret', tokenEndpointAuthMethod: 'client_secret_post', redirectUris: [] })
    expect(invalidated).toContain(integration.id)
    expect(changed.at(-1)).toEqual({ integrationId: integration.id, change: 'updated' })

    const flow = await start()
    if (flow.kind !== 'waiting') throw new Error(`expected waiting, got ${flow.kind}`)
    const auth = new URL(flow.url).searchParams
    expect(auth.get('client_id')).toBe('zoom-client')
    // An administrator's client registers nothing, whatever its redirect addresses.
    expect(fake.registrations.length).toBe(before)
    const code = fake.issueCode(auth.get('code_challenge') ?? '', auth.get('resource'), auth.get('redirect_uri'))
    const page = await oauth.complete(new URLSearchParams({ code, state: auth.get('state') ?? '' }))
    expect(page.status).toBe(200)
    const exchange = fake.tokenRequests.at(-1)
    expect(exchange?.get('client_id')).toBe('zoom-client')
    expect(exchange?.get('client_secret')).toBe('zoom-secret')
  })

  test('a client with no secret is a public client', async () => {
    fake.options.registration = false
    const { update, secrets, integration } = setup()
    const updated = await update({ clientId: 'public-client' })
    expect(updated.auth).toMatchObject({ clientId: 'public-client', hasClientSecret: false })
    expect(secrets.clients.get(integration.id)).toEqual({ clientId: 'public-client', tokenEndpointAuthMethod: 'none', redirectUris: [] })
  })

  test('null removes the client from the record and the secret store', async () => {
    fake.options.registration = false
    const { update, start, secrets, integration } = setup()
    await update({ clientId: 'zoom-client', clientSecret: 'zoom-secret' })
    const cleared = await update(null)
    expect(cleared.auth).toEqual({ kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required' })
    expect(secrets.clients.has(integration.id)).toBe(false)
    await expect(start()).rejects.toThrow('This server needs an OAuth client.')
  })

  test('only the owner sets the client; an administrator of the host does not', async () => {
    // WHY (D3): there are no shared MCP servers, so the OAuth client is the owner's
    // setting like the rest of the record. This changes the earlier rule, where the
    // host administrator set it for a shared server.
    installTestIdentities()
    const { updateAs, secrets, integration } = setup()
    const admin: Principal = { kind: 'org-member', userId: 'adam', organizationId: 'local', organizationRole: 'owner', teamIds: [], hostKind: 'managed', displayName: 'Adam', deviceId: 'd-adam', expiresAt: 0, deviceLabel: 'Solus cloud' }
    await expect(updateAs(admin, { clientId: 'stolen' })).rejects.toThrow('That integration is no longer on this host.')
    expect(secrets.clients.has(integration.id)).toBe(false)
  })

  test('an integration that does not sign in with OAuth refuses a client', async () => {
    const { store, update, integration } = setup()
    store.update(integration.id, { auth: { kind: 'none' } }, ANY_ORGANIZATION)
    await expect(update({ clientId: 'zoom-client' })).rejects.toThrow('This integration does not sign in with OAuth.')
  })
})
