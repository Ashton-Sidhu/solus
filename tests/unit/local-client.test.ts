import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { tokenEndpoint, type DirectoryHost, type PersonAccessTokenClaims } from '@solus/contracts/uplink'
import type { TokenVerdict } from '@solus/server/admission/access-tokens'
import { RemoteHosts } from '@solus/server/execution/orchestration/remote-hosts'
import { clientCredential, generateHostKey } from '@solus/server/host/host-credential'
import { LocalClientDoor } from '@solus/server/transport/local-client'
import { Delegations, type DelegationRefusal, type DelegationScope } from '@solus/server/sync/delegations'
import { AccountReads } from '@solus/server/vault/account-reads'

// docs/adr/0001-standard-authentication.md §2.2 rule 10, stage 6: the desktop's main
// process is an ordinary client of its own host. It presents its token for the host,
// and the host makes the owner's delegations from it with the same `establish` as the
// ticket door; nothing on the host asks for a token. The owner's account reads then go
// through those delegations, and the client's sign-out ends what its grant made.

const LINK = { hostId: 'host', issuer: 'https://account.test', jwksUrl: 'https://account.test/jwks', directoryUrl: 'https://account.test', hostname: 'host.test', proxiedPort: 1, connectionGeneration: 1, apiUrl: 'https://api.test' }
const hostKey = await generateHostKey()
const credential = clientCredential({ clientId: 'host_host', privateJwk: hostKey.privateJwk, tokenEndpoint: tokenEndpoint(LINK.directoryUrl) })

const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
const instances: Delegations[] = []
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-local-client-'))
  process.env.SOLUS_DATA_DIR = dataDir
})
afterEach(() => {
  for (const instance of instances.splice(0)) instance.clear()
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

/** A person's token for this host: only its claims matter, as `verify` stands for the host's verifier. */
function token(claims: Pick<PersonAccessTokenClaims, 'sub' | 'grant_id' | 'access'>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'ES256' })}.${part({ ...claims, aud: 'urn:solus:host:host' })}.c2ln`
}

function verifiedClaims(presented: string): PersonAccessTokenClaims {
  const claims = JSON.parse(Buffer.from(presented.split('.')[1]!, 'base64url').toString('utf8'))
  return { iss: LINK.issuer, jti: 'j', iat: 0, exp: 300, ...claims }
}

function world(options: { organizations?: string[]; verify?: (token: string) => TokenVerdict } = {}) {
  const exchanges: URLSearchParams[] = []
  const revoked: Array<[string, DelegationScope, DelegationRefusal]> = []
  let issued = 0
  const delegations = new Delegations({
    link: () => LINK,
    credential: () => credential,
    onRevoked: (userId, scope, refusal) => { revoked.push([userId, scope, refusal]) },
    fetchImpl: async (_url, init) => {
      const form = init?.body as URLSearchParams
      exchanges.push(form)
      issued += 1
      return Response.json({ access_token: `delegated-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 300 })
    },
  })
  instances.push(delegations)
  let established = 0
  const door = new LocalClientDoor({
    hostId: () => LINK.hostId,
    verify: async (presented) => options.verify?.(presented) ?? { ok: true, claims: verifiedClaims(presented) },
    delegations: () => delegations,
    organizationIds: () => options.organizations ?? [],
    onEstablished: () => { established += 1 },
  })
  const scopesOf = () => exchanges.filter((form) => form.get('grant_type') !== 'refresh_token').map((form) => form.get('delegation_scope') ?? form.get('organization_id'))
  return { delegations, door, exchanges, revoked, scopesOf, established: () => established }
}

const owner = token({ sub: 'alice', grant_id: 'grant_desktop', access: 'owner' })

describe('the desktop presents its token to its own host', () => {
  test('a signed-in desktop makes the owner’s personal delegation and one for each organization the host stands in', async () => {
    const w = world({ organizations: ['org_a'] })
    await w.door.presentToken(owner)
    expect(w.scopesOf()).toEqual(['personal', 'org_a'])
    expect(w.exchanges.every((form) => form.get('subject_token') === owner)).toBe(true)
    expect(w.delegations.holders()).toEqual([{ userId: 'alice', scope: 'personal' }, { userId: 'alice', scope: { organizationId: 'org_a' } }])
    // Work that waited for the delegations may go on.
    expect(w.established()).toBe(1)
    // A second presentation makes nothing again: a held delegation stays bound to its grant.
    await w.door.presentToken(owner)
    expect(w.scopesOf()).toEqual(['personal', 'org_a'])
  })

  test('a token the host does not accept, or a delegated one, makes no delegation', async () => {
    const refused = world({ verify: () => ({ ok: false, reason: 'not-linked' }) })
    await refused.door.presentToken(owner)
    const delegated = world({ verify: (presented) => ({ ok: true, claims: { ...verifiedClaims(presented), access: 'owner', act: { sub: 'host_other', host_id: 'other' } } }) })
    await delegated.door.presentToken(owner)
    expect([refused.exchanges, delegated.exchanges]).toEqual([[], []])
  })

  test('the owner’s account reads go with the delegation the presented token made', async () => {
    const w = world()
    await w.door.presentToken(owner)
    const sent: Array<{ url: string; authorization: string | null }> = []
    const reads = new AccountReads({
      origin: () => LINK.directoryUrl,
      delegations: () => w.delegations,
      fetchImpl: async (url, init) => {
        sent.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') })
        return Response.json({ ok: true })
      },
    })
    expect(await reads.fetch('alice', null, '/v1/integrations/github/credential', { method: 'POST' })).toBeInstanceOf(Response)
    expect(sent).toEqual([{ url: `${LINK.directoryUrl}/v1/integrations/github/credential`, authorization: 'Bearer delegated-1' }])
  })

  test('sign-out ends the delegations of the desktop’s grant at once; one a phone made goes on', async () => {
    const w = world({ organizations: ['org_a'] })
    // The phone connected first, through the ticket door: its grant made the Acme delegation.
    await w.delegations.establish(token({ sub: 'alice', grant_id: 'grant_phone', access: 'owner' }), { organizationId: 'org_a' })
    await w.door.presentToken(owner)
    w.door.signedOut()
    expect(w.revoked).toEqual([['alice', 'personal', 'GRANT_REVOKED']])
    expect(w.delegations.holders()).toEqual([{ userId: 'alice', scope: { organizationId: 'org_a' } }])
    // A second sign-out has nothing left to end.
    w.door.signedOut()
    expect(w.revoked).toHaveLength(1)
  })

  test('the host asks the client again only when its standing leaves the owner without a delegation', async () => {
    const organizations = ['org_a']
    const w = world({ organizations })
    let asked = 0
    const stop = w.door.onTokenWanted(() => { asked += 1 })
    w.door.standingChanged('alice')
    expect(asked).toBe(1)
    await w.door.presentToken(owner)
    w.door.standingChanged('alice')
    expect(asked).toBe(1)
    // A new organization shared the host: the owner has no delegation there yet.
    organizations.push('org_b')
    w.door.standingChanged('alice')
    expect(asked).toBe(2)
    // Unlinked: there is no owner to act for.
    w.door.standingChanged(null)
    stop()
    organizations.push('org_c')
    w.door.standingChanged('alice')
    expect(asked).toBe(2)
  })
})

describe('the owner’s other hosts follow the client’s sign-in', () => {
  const laptop: DirectoryHost = { hostId: 'h-book', installationId: 'install-h-book', label: 'Laptop', routes: [{ kind: 'tunnel', url: 'https://h-book.example' }], kind: 'personal', category: 'personal', organizationIds: [] }

  test('the directory and the host tokens come from the client while it lends them, and go with its sign-out', async () => {
    // WHY: docs/plans/cross-host-sessions.md §5.1 — a host reaches the owner's other hosts
    // only while the owner's client is signed in (ADR 0001 §2.2 rule 5); it holds no
    // token of its own for another host.
    const w = world()
    const hosts = new RemoteHosts(() => w.door.hostAccess(), { list: () => [], credential: async () => null }, () => LINK.hostId)
    expect(await hosts.list()).toEqual({ error: expect.stringContaining('sign in to your Solus account') })
    w.door.lendHostAccess({ hosts: async () => [laptop], accessToken: async (hostId) => `client-token-${hostId}` })
    const found = await hosts.find('Laptop')
    if ('error' in found) throw new Error(found.error)
    expect(await found.credential()).toBe('client-token-h-book')
    w.door.lendHostAccess(null)
    expect(await hosts.list()).toEqual({ error: expect.stringContaining('sign in to your Solus account') })
  })
})
