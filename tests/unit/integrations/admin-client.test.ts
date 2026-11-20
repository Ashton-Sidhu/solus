import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { OAUTH_CLIENT_REQUIRED_MESSAGE } from '@solus/contracts/integrations/oauth-protocol'
import { SOLUS_CLIENT_ID_URL, SOLUS_CLIENT_METADATA } from '@solus/contracts/integrations/client-metadata-document'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from '../helpers/bun-sqlite'
import type { IntegrationChangedEvent } from '@solus/contracts/integration-types'
import type { Principal } from '@solus/server/admission/principal'
import { TEST_HANDLER_CTX } from '../helpers/handler-ctx'
import { resetTestDatabase } from '../helpers/test-db'
import { installTestIdentities } from '../helpers/acting-identities'
import { startFakeServers, type FakeServers } from './fake-servers'
import { memoryClients, memorySecretStore } from './memory-secrets'

mock.module('node:sqlite', () => ({ DatabaseSync }))

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

function setup(fetchImpl?: typeof fetch, now?: () => number) {
  const secrets = memoryClients()
  const store = new IntegrationStore()
  const events = { connectionChanged: () => undefined, authFinished: () => undefined }
  const connections = new IntegrationConnectionStore()
  const vault = new Vault({ secrets: memorySecretStore() })
  const oauth = new IntegrationOAuth({ connections, integrations: store, vault, clients: secrets, events, fetch: fetchImpl, now })
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
    found: {} as never,
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
  return { secrets, store, oauth, integration, update, updateAs, start, changed, invalidated, server: () => server }
}

beforeAll(async () => {
  fake = await startFakeServers()
})

afterEach(async () => {
  fake.options.registration = true
  fake.options.metadataDocument = false
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
    await expect(start()).rejects.toThrow(OAUTH_CLIENT_REQUIRED_MESSAGE)
  })

  test('a server the probe saw registration on, but which refuses it at sign-in, is recorded as needing a client', async () => {
    fake.options.registration = false
    const { store, integration, changed, server } = setup()
    store.update(integration.id, { auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'dynamic' } }, 'local')
    await expect(withActingScope(ALICE, () => server().handle('integrationConnectStart', [{ id: integration.id, callbackBaseUrl: 'https://host.example' }], TEST_HANDLER_CTX)))
      .rejects.toThrow(OAUTH_CLIENT_REQUIRED_MESSAGE)
    // WHY: every client shows the client form and "Set up with an agent" from the record; a stale "dynamic" leaves a Sign in button that cannot work.
    expect(store.get(integration.id, ANY_ORGANIZATION)?.auth).toMatchObject({ registration: 'client-required' })
    expect(changed.at(-1)).toEqual({ integrationId: integration.id, change: 'updated' })
  })

  test('a mark made while the metadata document was not published goes once the host confirms the document', async () => {
    // WHY: the server reads Client ID Metadata Documents and has no registration
    // endpoint. Before the site serves Solus's document the sign-in refuses and
    // the record shows the client form; after the deploy the mark must go by
    // itself, or the person keeps a form they do not need (§13.1).
    fake.options.registration = false
    fake.options.metadataDocument = true
    let published = false
    let clock = Date.now()
    const fetchImpl: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === SOLUS_CLIENT_ID_URL) return published ? Response.json(SOLUS_CLIENT_METADATA) : new Response('not found', { status: 404 })
      return fetch(input, init)
    }, { preconnect: fetch.preconnect })
    const { store, integration, changed, server } = setup(fetchImpl, () => clock)
    store.update(integration.id, { auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'metadata-document' } }, 'local')
    const connect = () => withActingScope(ALICE, () => server().handle('integrationConnectStart', [{ id: integration.id, callbackBaseUrl: 'http://127.0.0.1:3001' }], TEST_HANDLER_CTX))
    const list = () => server().handle('integrationList', [], TEST_HANDLER_CTX)
    const auth = () => store.get(integration.id, ANY_ORGANIZATION)?.auth

    await expect(connect()).rejects.toThrow(OAUTH_CLIENT_REQUIRED_MESSAGE)
    expect(auth()).toMatchObject({ registration: 'client-required', awaitsClientDocument: true })
    // Still not published: a list keeps the mark (the read waits five minutes after a failed one).
    await list()
    expect(auth()).toMatchObject({ registration: 'client-required' })

    published = true
    clock += 6 * 60_000
    // The list answers at once; the clear follows, and the clients hear it as a change of the record.
    const cleared = new Promise<IntegrationChangedEvent>((resolve) => {
      const push = changed.push.bind(changed)
      changed.push = (...events) => {
        resolve(events[0]!)
        return push(...events)
      }
    })
    await list()
    expect(await cleared).toEqual({ integrationId: integration.id, change: 'updated' })
    expect(auth()).toEqual({ kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'metadata-document' })
    // The next sign-in uses the document: no registration, the document's URL as the client.
    const flow = await connect()
    if (flow.kind !== 'waiting') throw new Error(`expected waiting, got ${flow.kind}`)
    expect(new URL(flow.url).searchParams.get('client_id')).toBe(SOLUS_CLIENT_ID_URL)
  })

  test('a refusal while the document is confirmed is a mark that stays', async () => {
    // A callback the document does not name (a host on its own origin) cannot use it: the owner's client is the way.
    fake.options.registration = false
    fake.options.metadataDocument = true
    const fetchImpl: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === SOLUS_CLIENT_ID_URL) return Response.json(SOLUS_CLIENT_METADATA)
      return fetch(input, init)
    }, { preconnect: fetch.preconnect })
    const { store, integration, server } = setup(fetchImpl)
    store.update(integration.id, { auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'metadata-document' } }, 'local')
    await expect(withActingScope(ALICE, () => server().handle('integrationConnectStart', [{ id: integration.id, callbackBaseUrl: 'https://host.example' }], TEST_HANDLER_CTX)))
      .rejects.toThrow(OAUTH_CLIENT_REQUIRED_MESSAGE)
    expect(store.get(integration.id, ANY_ORGANIZATION)?.auth).toEqual({ kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required' })
  })

  test('a saved client with a secret signs in and sends the secret as client_secret_post', async () => {
    fake.options.registration = false
    const { update, start, oauth, secrets, integration, changed, invalidated } = setup()
    const before = fake.registrations.length
    const updated = await update({ clientId: 'zoom-client', clientSecret: 'zoom-secret' })
    // WHY: the record crosses the wire; it may say a secret exists but never carry it.
    expect(updated.auth).toEqual({ kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required', clientId: 'zoom-client', hasClientSecret: true })
    expect(JSON.stringify(updated)).not.toContain('zoom-secret')
    expect([...secrets.clients.values()]).toContainEqual({ clientId: 'zoom-client', clientSecret: 'zoom-secret', tokenEndpointAuthMethod: 'client_secret_post', redirectUris: [] })
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

  test('a custom client overrides automatic registration, and removal restores it', async () => {
    const { store, update, integration, start, oauth } = setup()
    store.update(integration.id, { auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'dynamic' } }, ANY_ORGANIZATION)
    const before = fake.registrations.length
    await update({ clientId: 'custom-client', clientSecret: 'custom-secret' })
    const manual = await start()
    if (manual.kind !== 'waiting') throw new Error('expected waiting')
    expect(new URL(manual.url).searchParams.get('client_id')).toBe('custom-client')
    expect(fake.registrations.length).toBe(before)
    withActingScope(ALICE, () => oauth.cancel(manual.flowId))
    await update(null)
    const automatic = await start()
    if (automatic.kind !== 'waiting') throw new Error('expected waiting')
    expect(new URL(automatic.url).searchParams.get('client_id')).not.toBe('custom-client')
    expect(fake.registrations.length).toBe(before + 1)
  })

  test('a client with no secret is a public client', async () => {
    fake.options.registration = false
    const { update, secrets, integration } = setup()
    const updated = await update({ clientId: 'public-client' })
    expect(updated.auth).toMatchObject({ clientId: 'public-client', hasClientSecret: false })
    expect([...secrets.clients.values()]).toContainEqual({ clientId: 'public-client', tokenEndpointAuthMethod: 'none', redirectUris: [] })
  })

  test('null removes the client from the record and the secret store', async () => {
    fake.options.registration = false
    const { update, start, secrets, integration } = setup()
    await update({ clientId: 'zoom-client', clientSecret: 'zoom-secret' })
    const cleared = await update(null)
    expect(cleared.auth).toEqual({ kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required' })
    expect(secrets.clients.has(integration.id)).toBe(false)
    await expect(start()).rejects.toThrow(OAUTH_CLIENT_REQUIRED_MESSAGE)
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
