import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { tokenEndpoint, type PersonAccessTokenClaims } from '@solus/contracts/uplink'
import type { TokenVerdict } from '@solus/server/admission/access-tokens'
import { clientCredential, generateHostKey } from '@solus/server/host/host-credential'
import { LocalClientDoor } from '@solus/server/transport/local-client'
import { Delegations, type DelegationRefusal, type DelegationScope } from '@solus/server/sync/delegations'
import { AccountReads } from '@solus/server/vault/account-reads'

// docs/adr/0001-standard-authentication.md §2.2 rule 10, stage 6: the desktop's main
// process is an ordinary client of its own host. It presents its token for the host,
// and the host makes the owner's delegations from it with the same `establish` as the
// ticket door; nothing on the host asks for a token. The owner's account reads then go
// through those delegations, and the client's sign-out ends what its grant made.

/** The host's registration; it has no link (ADR 0001 §2.2 rule 9): nothing below needs one. */
const REGISTRATION = { hostId: 'host', issuer: 'https://account.test', jwksUrl: 'https://account.test/jwks', directoryUrl: 'https://account.test', generation: 1, apiUrl: 'https://api.test' }
const hostKey = await generateHostKey()
const credential = clientCredential({ clientId: 'host_host', privateJwk: hostKey.privateJwk, tokenEndpoint: tokenEndpoint(REGISTRATION.directoryUrl) })

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
  return { iss: REGISTRATION.issuer, jti: 'j', iat: 0, exp: 300, ...claims }
}

function world(options: { organizations?: string[]; verify?: (token: string) => TokenVerdict } = {}) {
  const exchanges: URLSearchParams[] = []
  const revoked: Array<[string, DelegationScope, DelegationRefusal]> = []
  let issued = 0
  const delegations = new Delegations({
    registration: () => REGISTRATION,
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
    hostId: () => REGISTRATION.hostId,
    needsRegistration: () => false,
    register: async () => {},
    verify: async (presented) => options.verify?.(presented) ?? { ok: true, claims: verifiedClaims(presented) },
    delegations: () => delegations,
    organizationIds: () => options.organizations ?? [],
    onEstablished: () => { established += 1 },
    onOwnerIdentity: () => {},
  })
  const scopesOf = () => exchanges.filter((form) => form.get('grant_type') !== 'refresh_token').map((form) => form.get('delegation_scope') ?? form.get('organization_id'))
  return { delegations, door, exchanges, revoked, scopesOf, established: () => established }
}

const owner = token({ sub: 'alice', grant_id: 'grant_desktop', access: 'owner' })

describe('the desktop presents its token to its own host', () => {
  test('a signed-in desktop makes the owner’s personal delegation and one for each organization the host stands in', async () => {
    const w = world({ organizations: ['org_a'] })
    await w.door.presentToken(owner)
    // The two exchanges run at once, so they may finish in either order.
    expect(w.scopesOf().toSorted()).toEqual(['org_a', 'personal'])
    expect(w.exchanges.every((form) => form.get('subject_token') === owner)).toBe(true)
    expect(w.delegations.holders()).toHaveLength(2)
    expect(w.delegations.holders()).toEqual(expect.arrayContaining([{ userId: 'alice', scope: 'personal' }, { userId: 'alice', scope: { organizationId: 'org_a' } }]))
    // Work that waited for the delegations may go on.
    expect(w.established()).toBe(1)
    // A second presentation makes nothing again: a held delegation stays bound to its grant.
    await w.door.presentToken(owner)
    expect(w.scopesOf().toSorted()).toEqual(['org_a', 'personal'])
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
      origin: () => REGISTRATION.directoryUrl,
      delegations: () => w.delegations,
      fetchImpl: async (url, init) => {
        sent.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') })
        return Response.json({ ok: true })
      },
    })
    expect(await reads.fetch('alice', null, '/v1/integrations/github/credential', { method: 'POST' })).toBeInstanceOf(Response)
    expect(sent).toEqual([{ url: `${REGISTRATION.directoryUrl}/v1/integrations/github/credential`, authorization: 'Bearer delegated-1' }])
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

  test('when the phone that made the owner’s delegation signs out, the host asks the desktop again and its token makes it again', async () => {
    // WHY: a delegation stays bound to the first grant that made it. The desktop is
    // still signed in, so the owner's account reads must not end with the phone's grant
    // (ADR 0001 §6 item 5). The host's `onRevoked` asks through `standingChanged`.
    const w = world()
    let asked = 0
    w.door.onTokenWanted(() => { asked += 1 })
    const phone = token({ sub: 'alice', grant_id: 'grant_phone', access: 'owner' })
    await w.delegations.establish(phone, 'personal')
    await w.door.presentToken(owner)
    expect(w.scopesOf()).toEqual(['personal'])
    w.delegations.forgetGrant('grant_phone')
    w.door.standingChanged('alice')
    expect(asked).toBe(1)
    await w.door.presentToken(owner)
    expect(w.exchanges.map((form) => form.get('subject_token'))).toEqual([phone, owner])
    expect(w.delegations.holders()).toEqual([{ userId: 'alice', scope: 'personal' }])
    // The desktop's own sign-out now ends it.
    w.door.signedOut()
    expect(w.delegations.holders()).toEqual([])
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
    // Not registered: there is no owner to act for.
    w.door.standingChanged(null)
    stop()
    organizations.push('org_c')
    w.door.standingChanged('alice')
    expect(asked).toBe(2)
  })
})

describe('the owner’s delegation follows the desktop’s sign-in', () => {
  // WHY: while the desktop is signed in, the host acts for its owner. A delegation the
  // account plane refused, or one the host never got, is made again from the sign-in
  // during the call that needs it, so an account read does not fail for a signed-in owner.

  test('a refused refresh is made again from the desktop’s token, and the read goes on with it', async () => {
    let now = 1_000_000
    let issued = 0
    let refuseRefresh = false
    let door!: LocalClientDoor
    const delegations: Delegations = new Delegations({
      registration: () => REGISTRATION,
      credential: () => credential,
      onRevoked: () => {},
      renew: () => door.renew(),
      fetchImpl: async (_url, init) => {
        const form = init?.body as URLSearchParams
        if (form.get('grant_type') === 'refresh_token' && refuseRefresh) return Response.json({ error: 'invalid_request' }, { status: 400 })
        issued += 1
        return Response.json({ access_token: `delegated-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 300 })
      },
      now: () => now,
    })
    instances.push(delegations)
    door = new LocalClientDoor({
      hostId: () => REGISTRATION.hostId,
      needsRegistration: () => false,
      register: async () => {},
      verify: async (presented) => ({ ok: true, claims: verifiedClaims(presented) }),
      delegations: () => delegations,
      organizationIds: () => [],
      onEstablished: () => {},
      onOwnerIdentity: () => {},
    })
    // The desktop: asked for a token, it presents one and the ask resolves after it.
    let asked = 0
    door.onTokenWanted(async () => {
      asked += 1
      await door.presentToken(owner)
    })
    await door.presentToken(owner)
    refuseRefresh = true
    now += 400_000
    // Two reads at once share one ask.
    const tokens = await Promise.all([
      delegations.accessToken('alice', 'personal', { kind: 'account' }),
      delegations.accessToken('alice', 'personal', { kind: 'account' }),
    ])
    expect(tokens).toEqual(['delegated-2', 'delegated-2'])
    expect(asked).toBe(1)
  })

  test('with no client to ask, the ask resolves and the read fails as no delegation', async () => {
    const w = world()
    await w.door.renew()
    const reads = new AccountReads({ origin: () => REGISTRATION.directoryUrl, delegations: () => w.delegations, fetchImpl: async () => Response.json({}) })
    expect(await reads.fetch('alice', null, '/v1/account/agent-profile/read')).toMatchObject({ refused: 'NO_DELEGATION' })
  })
})

describe('the host’s registration and its client', () => {
  test('a host its desktop registered, and never linked, gets the owner’s personal delegation and reads the account with it', async () => {
    // WHY: the developer's desktop was not linked, so it had no key at the cloud, no
    // token audience, no delegation, and its account reads failed. Registration alone
    // must give all three (docs/adr/0001-standard-authentication.md §2.2 rules 8 and 9).
    const DIRECTORY = 'https://account.test'
    const routes: string[] = []
    const plane: typeof fetch = async (input, init) => {
      const url = String(input)
      routes.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
      if (url.endsWith('/v1/hosts/enroll')) {
        return Response.json({ registration: { hostId: 'host', issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/jwks`, directoryUrl: DIRECTORY, generation: 1 }, oauthClient: { clientId: 'host_host' } })
      }
      if (url === tokenEndpoint(DIRECTORY)) return Response.json({ access_token: 'delegated-account', refresh_token: 'refresh-1', expires_in: 300 })
      return Response.json({ ok: true })
    }
    const { HostRegistrar } = await import('@solus/server/host/host-registration')
    const registrar = new HostRegistrar({ installationId: () => 'install', hostLabel: () => 'Mac', os: () => 'macos', owner: () => null, fetchImpl: plane })
    const delegations = new Delegations({ registration: () => registrar.current(), credential: () => registrar.credential(), onRevoked: () => {}, fetchImpl: plane })
    instances.push(delegations)
    const door = new LocalClientDoor({
      hostId: () => registrar.current()?.hostId ?? null,
      needsRegistration: () => registrar.needsRegistration(),
      register: async (request) => { await registrar.register(request) },
      verify: async (presented) => ({ ok: true, claims: verifiedClaims(presented) }),
      delegations: () => delegations,
      organizationIds: () => [],
      onEstablished: () => {},
      onOwnerIdentity: () => {},
    })
    expect(door.needsRegistration()).toBe(true)
    await door.register({ ticket: 'set_desktop', directoryUrl: DIRECTORY })
    expect(door.hostId()).toBe('host')
    await door.presentToken(owner)
    expect(delegations.holders()).toEqual([{ userId: 'alice', scope: 'personal' }])
    const reads = new AccountReads({ origin: () => registrar.current()?.directoryUrl ?? null, delegations: () => delegations, fetchImpl: plane })
    expect(await reads.fetch('alice', null, '/v1/integrations/planetscale/credential', { method: 'POST' })).toBeInstanceOf(Response)
    // No route of the link was ever called.
    expect(routes.some((route) => route.endsWith('/link'))).toBe(false)
  })

  test('a registration made, changed, or ended asks the client again, so it presents a token for the new id or registers the host again', () => {
    const w = world()
    let asked = 0
    w.door.onTokenWanted(() => { asked += 1 })
    w.door.registrationChanged()
    expect(asked).toBe(1)
  })
})
