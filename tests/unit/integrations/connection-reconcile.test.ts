import { describe, expect, test } from 'bun:test'
import type { Integration, IntegrationConnection } from '@solus/contracts/integration-types'
import type { OAuthClient, OAuthToken } from '@solus/contracts/integrations/oauth-protocol'
import type { CloudCredentialRead, CloudCredentialUpload, McpCredentialRef, Vault } from '@solus/server/vault/vault'
import type { IntegrationConnectionStore } from '@solus/server/integrations/connection-store'
import { IntegrationConnections } from '@solus/server/integrations/connections'
import type { IntegrationOAuth } from '@solus/server/integrations/oauth'

// plans/020-agent-profile.md §5.2 and §5.4: a connection that lives in the account
// is read per call from the cloud, and a host-local one is moved there once. The
// vault's account reads themselves are tests/unit/vault.test.ts.

const OAUTH: Integration['auth'] = { kind: 'oauth', discover: 'https://linear.example/.well-known/oauth-protected-resource', registration: 'dynamic' }
const integration = (slug: string, auth: Integration['auth'] = { kind: 'bearer', scheme: 'bearer' }): Integration => ({
  id: `int-${slug}`, organizationId: 'org-a', ownerKey: 'alice', kind: 'mcp', slug, name: slug, url: `https://${slug}.example/mcp`, auth, createdBy: 'alice', createdAt: '', updatedAt: '',
})
const row = (integrationId: string, patch: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  integrationId, status: 'connected', source: 'host', label: 'Alice', info: null, error: null, updatedAt: '', ...patch,
})
const OWNER = { organizationId: 'org-a', ownerKey: 'alice' }

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
  // The vault: Alice's tokens on this host, and an account that answers `upload`.
  const vault = {
    read: async (_user: string, ref: McpCredentialRef) => {
      const token = tokens.get(ref.integrationId)
      return token ? { location: 'host', token } : null
    },
    remove: (_user: string, ref: McpCredentialRef) => {
      const token = tokens.get(ref.integrationId) ?? null
      tokens.delete(ref.integrationId)
      log.push(`token-removed:${ref.integrationId}`)
      return token
    },
    upload: async (_user: string, ref: McpCredentialRef) => { log.push(`upload:${ref.serverUrl}`); return options.upload(ref.serverUrl) },
  } as unknown as Vault
  const oauth = {
    revoke: async (each: Integration) => { log.push(`revoke:${each.slug}`) },
    tokenEndpointOf: async () => new URL('https://auth.example/token'),
    clientForToken: (): OAuthClient => ({ clientId: 'host-client', clientSecret: 's', tokenEndpointAuthMethod: 'client_secret_post' }),
    refreshIfDue: async (id: string) => tokens.get(id) ?? null,
  } as unknown as IntegrationOAuth
  const connections = new IntegrationConnections({
    store: store as IntegrationConnectionStore,
    integrations: { get: (id) => options.integrations.find((each) => each.id === id) ?? null, list: (_scope, viewer) => { listedFor.push(viewer); return options.integrations } },
    vault,
    clients: { removeClient: () => undefined },
    oauth,
    events: { connectionChanged: () => undefined, authFinished: () => undefined },
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
    await held.connections.reconcile(OWNER, [{ ref: { kind: 'mcp', serverUrl: linear.url }, material: 'oauth', status: 'connected', label: 'Alice', updatedAt: 1 }])
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
      { ref: { kind: 'mcp', serverUrl: linear.url }, material: 'oauth', status: 'connected', label: 'Alice', updatedAt: 1 },
      { ref: { kind: 'mcp', serverUrl: sentry.url }, material: 'key', status: 'connected', label: 'Alice', updatedAt: 1 },
    ])
    expect(subject.log).toEqual(['token-removed:int-linear', 'row:int-linear:cloud:connected', 'token-removed:int-sentry', 'row:int-sentry:cloud:connected'])
    expect(outcome.adopted).toEqual(['linear', 'sentry'])
    // The person's own servers: the reconcile reads the owner's records.
    expect(subject.listedFor).toEqual(['alice'])

    // One the account holds but needs a new sign-in leaves the host alone.
    const lapsed = host({ integrations: [linear], rows: new Map(), upload: () => ({ kind: 'uploaded', version: 1 }) })
    await lapsed.connections.reconcile(OWNER, [{ ref: { kind: 'mcp', serverUrl: linear.url }, material: 'oauth', status: 'needs-sign-in', label: null, updatedAt: 1 }])
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

describe('a cloud connection’s status says why it cannot be used', () => {
  // WHY: a host that has no Solus sign-in to read the account with did not ask the cloud,
  // so "Solus Cloud unreachable" was false and sent a signed-in person looking for an
  // outage. Each cause has its own status, and a row that waited reads again once the
  // person's delegation is made.
  function cloudHost(read: () => CloudCredentialRead) {
    const linear = integration('linear', OAUTH)
    const rows = new Map([[linear.id, row(linear.id, { source: 'cloud' })]])
    let answer = read
    const vault = {
      read: async () => ({ location: 'account', read: answer() }),
      forget: () => undefined,
    } as unknown as Vault
    const connections = new IntegrationConnections({
      store: {
        get: (id: string) => rows.get(id) ?? null,
        upsert: (id: string, _user: string | null, write: Partial<IntegrationConnection>) => { const next = row(id, { ...rows.get(id), ...write }); rows.set(id, next); return next },
        list: () => [...rows.values()],
      } as unknown as IntegrationConnectionStore,
      integrations: { get: (id) => (id === linear.id ? linear : null), list: () => [linear] },
      vault,
      clients: { removeClient: () => undefined },
      oauth: {} as IntegrationOAuth,
      events: { connectionChanged: () => undefined, authFinished: () => undefined },
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
