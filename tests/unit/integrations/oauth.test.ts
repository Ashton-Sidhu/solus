import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { OAUTH_CLIENT_REQUIRED_MESSAGE } from '@solus/contracts/integrations/oauth-protocol'
import { SOLUS_CLIENT_ID_URL, SOLUS_CLIENT_METADATA } from '@solus/contracts/integrations/client-metadata-document'
import { DEFAULT_DESKTOP_SERVER_PORT } from '@solus/contracts/types'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INTEGRATION_OAUTH_LOOPBACK_URL } from '@solus/contracts/integrations/oauth-callback'
import { join } from 'node:path'
import { DatabaseSync } from '../helpers/bun-sqlite'
import type { Integration, IntegrationAuthFinishedEvent, IntegrationConnectionChangedEvent } from '@solus/contracts/integration-types'
import { resetTestDatabase } from '../helpers/test-db'
import { startFakeServers, type FakeServers } from './fake-servers'
import { documentNaming, freeLoopbackPort } from './loopback-port'
import { memoryClients, memorySecretStore } from './memory-secrets'

mock.module('node:sqlite', () => ({ DatabaseSync }))

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

function setup(now = () => Date.now(), fetchImpl?: typeof fetch, loopbackPort = 0) {
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
  /** The client IDs the host reported for the record, as boot writes them on it. */
  const registered: string[] = []
  const recordRegisteredClient = (_integration: Integration, clientId: string) => { registered.push(clientId) }
  const oauth = new IntegrationOAuth({ connections: store, integrations, vault, clients, events, now, fetch: fetchImpl, loopbackPort, recordRegisteredClient })
  const connections = new IntegrationConnections({ store, integrations, vault, clients, oauth, events })
  return { hostToken, store, oauth, connections, clients, registered, changed, finished }
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
  fake.options.metadataDocument = false
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
  test('a wrong issuer in the callback cannot redeem the code', async () => {
    const { oauth } = setup()
    const flow = await startAs(ALICE, oauth)
    const params = approve(flow.url)
    params.set('iss', 'https://other.example')
    const before = fake.tokenRequests.length
    const page = await oauth.complete(params)
    expect(page.status).toBe(400)
    expect(page.html).toContain('different issuer')
    expect(fake.tokenRequests.length).toBe(before)
  })

  test('a token from another issuer is never accepted', async () => {
    const { oauth } = setup()
    expect(await oauth.acceptsToken(integration, { accessToken: 'old', tokenType: 'Bearer', issuer: 'https://other.example' })).toBe(false)
  })

  test('a saved client for one issuer is not found under another issuer', () => {
    const clients = memoryClients()
    clients.saveClient(integration.id, 'https://issuer-a.example', { clientId: 'client-a' })
    expect(clients.client(integration.id, 'https://issuer-b.example')).toBeNull()
  })
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
    const { oauth, registered } = setup()
    const before = fake.registrations.length
    await startAs(ALICE, oauth)
    await startAs(BOB, oauth)
    // WHY: a registration belongs to the host per integration; one per sign-in would flood the server.
    expect(fake.registrations.length - before).toBe(1)
    // WHY: the ID the server gave Solus goes on the record once, so the owner's client form can start from it.
    expect(registered).toEqual([`client-${before + 1}`])
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

  test('adding another account that signs in as an account already connected is refused', async () => {
    const { oauth, store, finished } = setup()
    await oauth.complete(approve((await startAs(ALICE, oauth)).url))
    const second = await withActingScope(ALICE, () => oauth.start(integration, START, 'acct-2'))
    if (second.kind !== 'waiting') throw new Error(`expected waiting, got ${second.kind}`)
    // The fake server reports one identity for every token, as a browser that skipped the chooser would.
    const page = await oauth.complete(approve(second.url))
    // WHY (§13.3): one mailbox as two accounts would run every read twice and make "which account" meaningless.
    expect(page.status).toBe(400)
    expect(store.accounts(integration.id, ALICE.personKey).map((account) => account.accountId)).toEqual(['default'])
    expect(finished.at(-1)?.event).toMatchObject({ outcome: 'failed', message: expect.stringContaining('already connected') })
  })

  test('a pasted redirect address completes the same as a callback, for its own person only', async () => {
    const { oauth, connections } = setup()
    const flow = await startAs(ALICE, oauth, { fallbackHost: '127.0.0.1', fallbackPort: 4100 })
    expect(flow.input).toBe('redirect-url')
    const pasted = `${INTEGRATION_OAUTH_LOOPBACK_URL}?${approve(flow.url)}`
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

  test('a refresh that works after one that failed makes the connection connected again', async () => {
    // A failed refresh says "it tries again on the next call"; when that call
    // works, the row must say so, or the gateway keeps skipping the account.
    fake.options.expiresIn = 30
    const { oauth, connections, store, changed } = setup()
    const flow = await startAs(ALICE, oauth)
    await oauth.complete(approve(flow.url))
    store.upsert(integration.id, ALICE.personKey, { status: 'error', error: 'Solus could not renew the sign-in. It tries again on the next call.' })
    fake.options.expiresIn = 3600
    expect(await connections.authorizationFor(integration.id, ALICE.personKey)).not.toBeNull()
    expect(store.get(integration.id, ALICE.personKey)).toMatchObject({ status: 'connected', error: null })
    expect(changed.at(-1)?.event.connection?.status).toBe('connected')
  })

  test('without registration or an administrator client, the sign-in says so', async () => {
    fake.options.registration = false
    const { oauth } = setup()
    const other: Integration = { ...integration, id: 'int-no-client', auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required' } }
    await expect(withActingScope(ALICE, () => oauth.start(other, START))).rejects.toThrow(OAUTH_CLIENT_REQUIRED_MESSAGE)
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

/** The desktop app on its own host: the renderer reaches the host on loopback, on the default port. */
const DESKTOP = { callbackBaseUrl: `http://127.0.0.1:${DEFAULT_DESKTOP_SERVER_PORT}`, fallbackHost: '127.0.0.1', fallbackPort: DEFAULT_DESKTOP_SERVER_PORT }

/**
 * A host whose reads of Solus's metadata document get `answer`; every other
 * request goes to the fake servers. `reads` counts the document reads.
 */
function publishing(answer: () => Response) {
  const reads: string[] = []
  const fetchImpl: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === SOLUS_CLIENT_ID_URL) {
      reads.push(String(input))
      return answer()
    }
    return fetch(input, init)
  }, { preconnect: fetch.preconnect })
  return { fetchImpl, reads }
}

describe('the Client ID Metadata Document (§13.1)', () => {
  test('signs in with the document when it is published and the server reads such documents', async () => {
    fake.options.metadataDocument = true
    // A test host's port stands in for the fixed one, which the document names exactly.
    const port = await freeLoopbackPort()
    const { fetchImpl } = publishing(() => Response.json(documentNaming(port)))
    const { oauth, connections } = setup(undefined, fetchImpl, port)
    const before = fake.registrations.length
    const flow = await startAs(ALICE, oauth, DESKTOP)
    const url = new URL(flow.url)
    // WHY: the server reads Solus's name and callbacks from the URL; no registration is made or kept.
    expect(url.searchParams.get('client_id')).toBe(SOLUS_CLIENT_ID_URL)
    expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/callback`)
    expect(fake.registrations.length).toBe(before)
    expect((await oauth.complete(approve(flow.url))).status).toBe(200)
    // A public client: the exchange names the client and sends no secret.
    const exchange = fake.tokenRequests.at(-1)
    expect(exchange?.get('client_id')).toBe(SOLUS_CLIENT_ID_URL)
    expect(exchange?.has('client_secret')).toBe(false)
    expect(await connections.authorizationFor(integration.id, ALICE.personKey)).toMatch(/^Bearer access-/)
  })

  for (const [name, answer] of [
    ['not yet published', () => new Response('Not found', { status: 404 })],
    ['published for another URL', () => Response.json({ ...SOLUS_CLIENT_METADATA, client_id: 'https://solus.sh/other.json' })],
    ['moved with a redirect', () => new Response(null, { status: 302, headers: { location: 'https://solus.sh/elsewhere.json' } })],
    ['unreachable', () => { throw new TypeError('fetch failed') }],
  ] as const) {
    test(`registers dynamically when the document is ${name}`, async () => {
      fake.options.metadataDocument = true
      const { fetchImpl, reads } = publishing(answer)
      const { oauth } = setup(undefined, fetchImpl)
      const before = fake.registrations.length
      const flow = await startAs(ALICE, oauth, DESKTOP)
      // WHY: the server would fetch the URL itself and fail the sign-in in the browser, where Solus cannot fall back.
      expect(reads.length).toBe(1)
      expect(new URL(flow.url).searchParams.get('client_id')).toBe(`client-${before + 1}`)
      expect(fake.registrations.length).toBe(before + 1)
    })
  }

  test('a callback the document does not name registers dynamically', async () => {
    fake.options.metadataDocument = true
    const { fetchImpl } = publishing(() => Response.json(SOLUS_CLIENT_METADATA))
    const { oauth } = setup(undefined, fetchImpl)
    const before = fake.registrations.length
    // A host on its own origin, and a loopback callback on a port the system picked.
    for (const start of [START, DESKTOP]) {
      const flow = await startAs(ALICE, oauth, start)
      // WHY: the server compares the callback as a plain string; one the document does not list would be refused.
      expect(new URL(flow.url).searchParams.get('client_id')).not.toBe(SOLUS_CLIENT_ID_URL)
    }
    expect(fake.registrations.length).toBe(before + 2)
  })

  test('a server that does not read such documents never gets one, and the host does not read it', async () => {
    const { fetchImpl, reads } = publishing(() => Response.json(SOLUS_CLIENT_METADATA))
    const { oauth } = setup(undefined, fetchImpl)
    const flow = await startAs(ALICE, oauth, DESKTOP)
    expect(new URL(flow.url).searchParams.get('client_id')).not.toBe(SOLUS_CLIENT_ID_URL)
    expect(reads).toEqual([])
  })

  test('the owner\'s own client still wins over the document', async () => {
    fake.options.metadataDocument = true
    const { fetchImpl } = publishing(() => Response.json(SOLUS_CLIENT_METADATA))
    const { oauth } = setup(undefined, fetchImpl)
    const owned: Integration = { ...integration, auth: { ...integration.auth, kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'metadata-document', clientId: 'owner-client' } }
    const result = await withActingScope(ALICE, () => oauth.start(owned, DESKTOP))
    if (result.kind !== 'waiting') throw new Error(`expected waiting, got ${result.kind}`)
    // WHY: an explicit choice wins; the owner registered this client and its callbacks at the server.
    expect(new URL(result.url).searchParams.get('client_id')).toBe('owner-client')
  })

  /** A host whose document is published for `port`, at a server whose authorize page gives `answer`. `asked` holds the client IDs it was asked about. */
  async function refusingAuthorize(answer: () => Response) {
    const port = await freeLoopbackPort()
    const asked: string[] = []
    const { fetchImpl: published } = publishing(() => Response.json(documentNaming(port)))
    const fetchImpl: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/as/authorize')) {
        asked.push(url.searchParams.get('client_id') ?? '')
        return answer()
      }
      return published(input, init)
    }, { preconnect: fetch.preconnect })
    return { ...setup(undefined, fetchImpl, port), asked }
  }

  // Lovable's answer to Solus's document today: it trusts only some domains.
  const LOVABLE_REFUSAL = () => new Response('<title>Authorization failed - Lovable</title>', { status: 400, headers: { 'content-type': 'text/html' } })

  test('a server that refuses the document at its authorize page gets a dynamic registration instead', async () => {
    fake.options.metadataDocument = true
    const { oauth, asked } = await refusingAuthorize(LOVABLE_REFUSAL)
    const before = fake.registrations.length
    const flow = await startAs(ALICE, oauth, DESKTOP)
    // WHY: the server would show its refusal in the browser and never return to Solus, so Solus asks first and falls back.
    expect(asked).toEqual([SOLUS_CLIENT_ID_URL])
    expect(new URL(flow.url).searchParams.get('client_id')).toBe(`client-${before + 1}`)
    expect(fake.registrations.length).toBe(before + 1)
  })

  test('a server that refuses the document and does not register clients asks for the person\'s own client', async () => {
    fake.options.metadataDocument = true
    fake.options.registration = false
    const { oauth } = await refusingAuthorize(LOVABLE_REFUSAL)
    // WHY: a plain message in Solus, not a dead end in the browser.
    await expect(startAs(ALICE, oauth, DESKTOP)).rejects.toThrow(OAUTH_CLIENT_REQUIRED_MESSAGE)
  })

  test('an unclear answer keeps the document', async () => {
    fake.options.metadataDocument = true
    const { oauth } = await refusingAuthorize(() => new Response('Too many requests', { status: 429 }))
    const flow = await startAs(ALICE, oauth, DESKTOP)
    // WHY: only a clear refusal changes the sign-in; a rate limit or a bot wall says nothing about the client.
    expect(new URL(flow.url).searchParams.get('client_id')).toBe(SOLUS_CLIENT_ID_URL)
  })
})

describe('one callback (§13.1)', () => {
  test('a browser on the host returns to the loopback listener, which closes once the sign-in ends', async () => {
    const { oauth, connections } = setup()
    const flow = await startAs(ALICE, oauth, DESKTOP)
    const redirect = new URL(new URL(flow.url).searchParams.get('redirect_uri') ?? '')
    // WHY: `/callback` on a loopback IP is the shape servers that allow only known clients accept (HiddenLayer refuses the host route).
    expect(redirect.hostname).toBe('127.0.0.1')
    expect(redirect.pathname).toBe('/callback')
    expect(flow.input).toBe('callback')
    const page = await fetch(`${redirect.href}?${approve(flow.url)}`)
    expect(page.status).toBe(200)
    expect(await connections.authorizationFor(integration.id, ALICE.personKey)).toMatch(/^Bearer access-/)
    // WHY: Solus holds the port only while a sign-in waits on it.
    await expect(fetch(redirect.href)).rejects.toThrow()
  })

  test('a browser elsewhere returns to the host route on its origin; one that cannot reach the host pastes the loopback address', async () => {
    const { oauth } = setup()
    const remote = await startAs(ALICE, oauth, START)
    expect(new URL(remote.url).searchParams.get('redirect_uri')).toBe('https://host.example/oauth/integration/callback')
    expect(remote.input).toBe('callback')
    const unreachable = await startAs(BOB, oauth, { fallbackHost: '127.0.0.1', fallbackPort: 4100 })
    expect(new URL(unreachable.url).searchParams.get('redirect_uri')).toBe(INTEGRATION_OAUTH_LOOPBACK_URL)
    expect(unreachable.input).toBe('redirect-url')
  })

  test('an owner app saved now returns to the loopback callback from any device; one saved before keeps the host route', async () => {
    const { oauth, clients } = setup()
    const owned = (clientId: string): Integration => ({ ...integration, auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required', clientId } })
    const auth = await oauth.withOwnerClient({ ...integration, auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'dynamic', registeredClientId: 'static-id' } }, { clientId: 'new-app' })
    // The server's ID stays on the record, so removing the owner's client starts the form from it again.
    expect(auth).toMatchObject({ clientId: 'new-app', registeredClientId: 'static-id' })
    // WHY: the owner registered the URL Solus showed them, so every sign-in must send that exact URL.
    const fromElsewhere = await withActingScope(ALICE, () => oauth.start(owned('new-app'), START))
    if (fromElsewhere.kind !== 'waiting') throw new Error('expected waiting')
    expect(new URL(fromElsewhere.url).searchParams.get('redirect_uri')).toBe(INTEGRATION_OAUTH_LOOPBACK_URL)
    expect(fromElsewhere.input).toBe('redirect-url')

    clients.saveClient(integration.id, await oauth.issuerOf(integration), { clientId: 'old-app', tokenEndpointAuthMethod: 'none', redirectUris: [] })
    const legacy = await withActingScope(BOB, () => oauth.start(owned('old-app'), START))
    if (legacy.kind !== 'waiting') throw new Error('expected waiting')
    expect(new URL(legacy.url).searchParams.get('redirect_uri')).toBe('https://host.example/oauth/integration/callback')
  })

  test('with the fixed port in use, a dynamic client takes another port and an owner app is refused plainly', async () => {
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
    const busyPort = (holder.address() as AddressInfo).port
    try {
      const { oauth, clients } = setup(undefined, undefined, busyPort)
      const flow = await startAs(ALICE, oauth, DESKTOP)
      const redirect = new URL(new URL(flow.url).searchParams.get('redirect_uri') ?? '')
      expect(redirect.pathname).toBe('/callback')
      expect(Number(redirect.port)).not.toBe(busyPort)
      await withActingScope(ALICE, () => oauth.cancel(flow.flowId))

      clients.saveClient(integration.id, await oauth.issuerOf(integration), { clientId: 'owner-app', tokenEndpointAuthMethod: 'none', redirectUris: [INTEGRATION_OAUTH_LOOPBACK_URL] })
      const owned: Integration = { ...integration, auth: { kind: 'oauth', discover: fake.resourceMetadataUrl, registration: 'client-required', clientId: 'owner-app' } }
      // WHY: the owner's app lists the fixed port; another port would fail at the server's sign-in page, where Solus cannot explain it.
      await expect(withActingScope(BOB, () => oauth.start(owned, DESKTOP))).rejects.toThrow(/needs port/)
    } finally {
      holder.close()
    }
  })
})
