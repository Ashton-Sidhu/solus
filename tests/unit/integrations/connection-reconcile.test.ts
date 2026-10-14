import { describe, expect, test } from 'bun:test'
import type { Integration, IntegrationConnection } from '@solus/contracts/integration-types'
import type { ProfileCredential } from '@solus/contracts/integrations/profile-credentials'
import type { OAuthClient, OAuthToken } from '@solus/contracts/integrations/oauth-protocol'
import { CloudIntegrationCredentials, type CloudCredentialRead, type CloudCredentialUpload } from '@solus/server/integrations/cloud-credentials'
import { AccountReads } from '@solus/server/vault/account-reads'
import type { IntegrationConnectionStore, IntegrationSecrets } from '@solus/server/integrations/connection-store'
import { IntegrationConnections } from '@solus/server/integrations/connections'
import type { IntegrationOAuth } from '@solus/server/integrations/oauth'

// plans/020-agent-profile.md §5.2 and §5.4: a connection that lives in the account
// is read per call from the cloud, and a host-local one is moved there once.

const OAUTH: Integration['auth'] = { kind: 'oauth', discover: 'https://linear.example/.well-known/oauth-protected-resource', registration: 'dynamic' }
const integration = (slug: string, auth: Integration['auth'] = { kind: 'bearer', scheme: 'bearer' }): Integration => ({
  id: `int-${slug}`, organizationId: 'org-a', ownerUserId: 'alice', kind: 'mcp', slug, name: slug, url: `https://${slug}.example/mcp`, auth, createdBy: 'alice', createdAt: '', updatedAt: '',
})
const row = (integrationId: string, patch: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  integrationId, status: 'connected', source: 'host', label: 'Alice', info: null, error: null, updatedAt: '', ...patch,
})
const OWNER = { organizationId: 'org-a', ownerUserId: 'alice' }

/** A host with these integrations, Alice's rows, and her tokens, over a fake cloud that answers `upload`. */
function host(options: { integrations: Integration[]; rows: Map<string, IntegrationConnection>; tokens?: Map<string, OAuthToken>; upload: (serverUrl: string) => CloudCredentialUpload }) {
  const log: string[] = []
  const listedFor: (string | null)[] = []
  const tokens = options.tokens ?? new Map<string, OAuthToken>()
  const rows = options.rows
  const store: Pick<IntegrationConnectionStore, 'get' | 'upsert' | 'remove' | 'removeAllFor' | 'list'> = {
    get: (id) => rows.get(id) ?? null,
    upsert: (id, _user, write) => { const next = row(id, { ...rows.get(id), ...write }); rows.set(id, next); log.push(`row:${id}:${next.source}:${next.status}`); return next },
    remove: (id) => rows.delete(id),
    removeAllFor: () => [],
    list: () => [...rows.values()],
  }
  const secrets: IntegrationSecrets = {
    token: (id) => tokens.get(id) ?? null,
    saveToken: (id, _user, token) => { tokens.set(id, token) },
    removeToken: (id) => { tokens.delete(id); log.push(`token-removed:${id}`) },
    client: () => ({ clientId: 'host-client', clientSecret: 's', tokenEndpointAuthMethod: 'client_secret_post' }),
    saveClient: () => undefined,
    removeClient: () => undefined,
  }
  const oauth = {
    revoke: async (each: Integration) => { log.push(`revoke:${each.slug}`) },
    tokenEndpointOf: async () => new URL('https://auth.example/token'),
    clientForToken: (): OAuthClient => ({ clientId: 'host-client', clientSecret: 's', tokenEndpointAuthMethod: 'client_secret_post' }),
    refreshIfDue: async (id: string) => tokens.get(id) ?? null,
  } as unknown as IntegrationOAuth
  const cloud = { upload: async (_user: string | null, serverUrl: string) => { log.push(`upload:${serverUrl}`); return options.upload(serverUrl) } } as unknown as CloudIntegrationCredentials
  const connections = new IntegrationConnections({
    store: store as IntegrationConnectionStore,
    integrations: { get: (id) => options.integrations.find((each) => each.id === id) ?? null, list: (_scope, viewer) => { listedFor.push(viewer); return options.integrations } },
    secrets,
    oauth,
    events: { connectionChanged: () => undefined, authFinished: () => undefined },
    cloud,
  })
  return { connections, log, rows, tokens, listedFor }
}

describe('connection reconcile', () => {
  test('a connection the cloud does not hold is uploaded, then the host drops its copy without revoking the token the cloud now holds', async () => {
    const linear = integration('linear')
    const subject = host({
      integrations: [linear],
      rows: new Map([[linear.id, row(linear.id)]]),
      tokens: new Map([[linear.id, { accessToken: 'k', tokenType: 'api-key' }]]),
      upload: () => ({ kind: 'uploaded', version: 1 }),
    })
    const outcome = await subject.connections.reconcile(OWNER, [])
    expect(subject.log).toEqual(['upload:https://linear.example/mcp', 'token-removed:int-linear', 'row:int-linear:cloud:connected'])
    expect(outcome).toEqual({ uploaded: ['linear'], adopted: [], kept: [] })
  })

  test('a connection the cloud already holds wins: the host revokes its own token and reads from the account', async () => {
    // WHY: two refreshers of one token log each other out; the cloud is the one.
    const linear = integration('linear', OAUTH)
    const token: OAuthToken = { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', clientId: 'host-client' }
    const held = host({ integrations: [linear], rows: new Map([[linear.id, row(linear.id)]]), tokens: new Map([[linear.id, token]]), upload: () => ({ kind: 'uploaded', version: 1 }) })
    await held.connections.reconcile(OWNER, [{ serverUrl: linear.url, kind: 'oauth', status: 'connected', label: 'Alice', updatedAt: 1 }])
    expect(held.log).toEqual(['token-removed:int-linear', 'revoke:linear', 'row:int-linear:cloud:connected'])

    // A race: the upload finds one the other host wrote first.
    const raced = host({ integrations: [linear], rows: new Map([[linear.id, row(linear.id)]]), tokens: new Map([[linear.id, token]]), upload: () => ({ kind: 'held', currentVersion: 2 }) })
    const outcome = await raced.connections.reconcile(OWNER, [])
    expect(raced.log).toEqual(['upload:https://linear.example/mcp', 'token-removed:int-linear', 'revoke:linear', 'row:int-linear:cloud:connected'])
    expect(outcome.adopted).toEqual(['linear'])
  })

  test('a sign-in made at the cloud reaches a host that holds nothing for it, or holds a lapsed row', async () => {
    // WHY: a signed-in person signs in at the cloud; the host learns of it only on this pull.
    const linear = integration('linear', OAUTH)
    const sentry = integration('sentry')
    const subject = host({
      integrations: [linear, sentry],
      rows: new Map([[sentry.id, row(sentry.id, { status: 'needs-sign-in' })]]),
      upload: () => ({ kind: 'uploaded', version: 1 }),
    })
    const outcome = await subject.connections.reconcile(OWNER, [
      { serverUrl: linear.url, kind: 'oauth', status: 'connected', label: 'Alice', updatedAt: 1 },
      { serverUrl: sentry.url, kind: 'bearer', status: 'connected', label: 'Alice', updatedAt: 1 },
    ])
    expect(subject.log).toEqual(['token-removed:int-linear', 'row:int-linear:cloud:connected', 'token-removed:int-sentry', 'row:int-sentry:cloud:connected'])
    expect(outcome.adopted).toEqual(['linear', 'sentry'])
    // The person's view: the host's shared servers with their own, not only their own.
    expect(subject.listedFor).toEqual(['alice'])

    // One the account holds but needs a new sign-in leaves the host alone.
    const lapsed = host({ integrations: [linear], rows: new Map(), upload: () => ({ kind: 'uploaded', version: 1 }) })
    await lapsed.connections.reconcile(OWNER, [{ serverUrl: linear.url, kind: 'oauth', status: 'needs-sign-in', label: null, updatedAt: 1 }])
    expect(lapsed.log).toEqual([])
  })

  test('an unreachable cloud, an open server, a cloud connection, a row that needs sign-in, and a token the host cannot refresh each leave the host as it is', async () => {
    // WHY: nothing is deleted before the cloud confirmed the write.
    const linear = integration('linear')
    const open = integration('deepwiki', { kind: 'none' })
    const already = integration('context7')
    const lapsed = integration('sentry')
    const stale = integration('notion', OAUTH)
    const subject = host({
      integrations: [linear, open, already, lapsed, stale],
      rows: new Map([
        [linear.id, row(linear.id)],
        [open.id, row(open.id)],
        [already.id, row(already.id, { source: 'cloud' })],
        [lapsed.id, row(lapsed.id, { status: 'needs-sign-in' })],
        [stale.id, row(stale.id)],
      ]),
      tokens: new Map([[linear.id, { accessToken: 'k', tokenType: 'api-key' }], [stale.id, { accessToken: 'a', tokenType: 'Bearer' }]]),
      upload: () => ({ kind: 'unreachable' }),
    })
    const outcome = await subject.connections.reconcile(OWNER, [])
    expect(subject.log).toEqual(['upload:https://linear.example/mcp'])
    expect(outcome).toEqual({ uploaded: [], adopted: [], kept: ['linear', 'notion'] })
    expect(subject.tokens.size).toBe(2)
  })
})

describe('cloud credentials', () => {
  function cloud(answer: (request: Request) => Promise<Response>, now = { at: 1_000_000 }) {
    const requests: Request[] = []
    // The host acts for alice; every read carries her delegated token as the bearer (ADR 0001 §2.2 rule 7).
    const reads = new AccountReads({
      origin: () => 'https://cloud.test',
      delegations: () => ({ holders: () => [{ userId: 'alice', scope: 'personal' }], accessToken: async () => 'alice-delegated' }),
      fetchImpl: async (input, init) => { const request = new Request(input, init); requests.push(request); return answer(request) },
    })
    const credentials = new CloudIntegrationCredentials({
      reads,
      userFor: (credentialUserId) => credentialUserId,
      now: () => now.at,
    })
    return { credentials, requests, now }
  }

  test('a delivered token is cached until a minute before it expires, then read again', async () => {
    const { credentials, requests, now } = cloud(async () => Response.json({ authorization: 'Bearer t1', expiresAt: now.at + 120_000, label: 'Alice' }))
    expect(await credentials.read('alice', 'https://linear.example/mcp')).toMatchObject({ kind: 'ok', delivery: { authorization: 'Bearer t1' } })
    expect(await credentials.read('alice', 'https://linear.example/mcp')).toMatchObject({ kind: 'ok' })
    expect(requests).toHaveLength(1)
    expect(requests[0].headers.get('authorization')).toBe('Bearer alice-delegated')
    expect(await requests[0].json()).toEqual({ serverUrl: 'https://linear.example/mcp' })
    now.at += 61_000
    await credentials.read('alice', 'https://linear.example/mcp')
    expect(requests).toHaveLength(2)
  })

  test('not connected, a refused refresh, and an unreachable cloud are told apart, and the cache answers while the cloud is down', async () => {
    let mode: 'ok' | 'gone' | 'refused' | 'down' = 'ok'
    const { credentials, now } = cloud(async () => {
      if (mode === 'down') throw new Error('ECONNREFUSED')
      if (mode === 'gone') return Response.json({ error: 'not_connected' }, { status: 404 })
      if (mode === 'refused') return Response.json({ error: 'reconnect_required' }, { status: 409 })
      return Response.json({ authorization: 'Bearer t1', expiresAt: now.at + 120_000, label: null })
    })
    await credentials.read('alice', 'https://a.example/mcp')
    mode = 'down'
    now.at += 61_000
    expect(await credentials.read('alice', 'https://a.example/mcp')).toEqual({ kind: 'unreachable' })
    expect(credentials.cached('alice', 'https://a.example/mcp')?.authorization).toBe('Bearer t1')
    now.at += 60_000
    expect(credentials.cached('alice', 'https://a.example/mcp')).toBeNull()
    mode = 'gone'
    expect(await credentials.read('alice', 'https://a.example/mcp')).toEqual({ kind: 'not-connected' })
    mode = 'refused'
    expect(await credentials.read('alice', 'https://a.example/mcp')).toEqual({ kind: 'reconnect-required' })
  })

  // WHY: after sign-out the host must not go on with a credential the ended delegation brought (ADR 0001 rule 5).
  test('a cleared cache answers nothing, not even while the cloud is down', async () => {
    let down = false
    const { credentials, requests, now } = cloud(async () => {
      if (down) throw new Error('ECONNREFUSED')
      return Response.json({ authorization: 'Bearer t1', expiresAt: now.at + 3_600_000, label: null })
    })
    await credentials.read('alice', 'https://a.example/mcp')
    credentials.clear()
    expect(credentials.cached('alice', 'https://a.example/mcp')).toBeNull()
    down = true
    expect(await credentials.read('alice', 'https://a.example/mcp')).toEqual({ kind: 'unreachable' })
    expect(requests).toHaveLength(2)
  })

  test('a person this host does not act for is read for nobody: nothing is sent', async () => {
    const { credentials, requests } = cloud(async () => Response.json({}))
    expect(await credentials.read('bob', 'https://a.example/mcp')).toEqual({ kind: 'no-executor' })
    expect(requests).toEqual([])
  })

  test('an upload answers uploaded, held, or refused by the cloud\'s status', async () => {
    const credential: ProfileCredential = { kind: 'bearer', key: 'k', scheme: 'bearer' }
    const answers: Response[] = [
      Response.json({ version: 1 }, { status: 201 }),
      Response.json({ error: 'credential_held', currentVersion: 2 }, { status: 409 }),
      Response.json({ error: 'invalid_credential' }, { status: 422 }),
    ]
    const { credentials, requests } = cloud(async () => answers.shift()!)
    expect(await credentials.upload('alice', 'https://a.example/mcp', credential, 'Alice')).toEqual({ kind: 'uploaded', version: 1 })
    expect(await credentials.upload('alice', 'https://a.example/mcp', credential, null)).toEqual({ kind: 'held', currentVersion: 2 })
    expect(await credentials.upload('alice', 'https://a.example/mcp', credential, null)).toEqual({ kind: 'refused' })
    expect(requests[0].method).toBe('PUT')
    expect(requests[0].headers.get('authorization')).toBe('Bearer alice-delegated')
    expect(await requests[0].json()).toEqual({ serverUrl: 'https://a.example/mcp', expectedVersion: null, credential, label: 'Alice' })
  })
})

describe('a cloud connection’s status says why it cannot be used', () => {
  // WHY: a host that has no Solus sign-in to read the account with did not ask the cloud,
  // so "Solus Cloud unreachable" was false and sent a signed-in person looking for an
  // outage. Each cause has its own status, and a row that waited reads again once the
  // person's delegation is made.
  function cloudHost(read: () => CloudCredentialRead) {
    const linear = integration('linear', OAUTH)
    const rows = new Map([[linear.id, row(linear.id, { source: 'cloud' })]])
    let answer = read
    const cloud = {
      read: async () => answer(),
      cached: () => null,
      forget: () => undefined,
    } as unknown as CloudIntegrationCredentials
    const connections = new IntegrationConnections({
      store: {
        get: (id: string) => rows.get(id) ?? null,
        upsert: (id: string, _user: string | null, write: Partial<IntegrationConnection>) => { const next = row(id, { ...rows.get(id), ...write }); rows.set(id, next); return next },
        list: () => [...rows.values()],
      } as unknown as IntegrationConnectionStore,
      integrations: { get: (id) => (id === linear.id ? linear : null), list: () => [linear] },
      secrets: {} as IntegrationSecrets,
      oauth: {} as IntegrationOAuth,
      events: { connectionChanged: () => undefined, authFinished: () => undefined },
      cloud,
    })
    return { connections, linear, rows, answer: (next: () => CloudCredentialRead) => { answer = next } }
  }

  test('no sign-in to read the account with says so; an outage says unreachable', async () => {
    const signedOut = cloudHost(() => ({ kind: 'no-executor' }))
    expect(await signedOut.connections.authorizationFor(signedOut.linear.id, 'alice')).toBeNull()
    expect(signedOut.rows.get(signedOut.linear.id)?.status).toBe('needs-solus-sign-in')
    const outage = cloudHost(() => ({ kind: 'unreachable' }))
    expect(await outage.connections.authorizationFor(outage.linear.id, 'alice')).toBeNull()
    expect(outage.rows.get(outage.linear.id)?.status).toBe('cloud-unreachable')
  })

  test('once the delegation is made, a row that waited is read again and says connected', async () => {
    const w = cloudHost(() => ({ kind: 'no-executor' }))
    await w.connections.authorizationFor(w.linear.id, 'alice')
    w.answer(() => ({ kind: 'ok', delivery: { authorization: 'Bearer cloud', expiresAt: null, label: null } }))
    await w.connections.recheckCloud('alice')
    expect(w.rows.get(w.linear.id)?.status).toBe('connected')
  })
})
