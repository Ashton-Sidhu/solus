import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPublicKey, verify } from 'crypto'
import { ACCOUNT_AUDIENCE, CLIENT_ASSERTION_TYPE, SOLUS_API_AUDIENCE, tokenEndpoint } from '@solus/contracts/uplink'
import { clientCredential, generateHostKey } from '@solus/server/host/host-credential'
import { Delegations, type DelegationRefusal, type DelegationScope } from '@solus/server/sync/delegations'

// docs/adr/0001-standard-authentication.md §2.2 rules 5 and 6, §3.4: a host acts for a
// person only through a delegation, made by token exchange from an access token their
// client presented here, for one scope (`personal` or one organization), and bound to
// that client's grant. A refusal of the grant ends the person's work in that scope only.

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

/** An access token a client presented: only its claims matter here, as the ticket door verified it. */
function presented(sub: string, grantId: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'ES256', kid: 'k1' })}.${part({ sub, grant_id: grantId, aud: 'urn:solus:host:host' })}.c2ln`
}

const LINK = { hostId: 'host', issuer: 'https://account.test', jwksUrl: 'https://account.test/jwks', directoryUrl: 'https://account.test', generation: 1, apiUrl: 'https://api.test' }
/** The host's key: every exchange and refresh is authenticated with an assertion it signs (ADR 0001 §3.4). */
const hostKey = await generateHostKey()
const credential = clientCredential({ clientId: 'host_host', privateJwk: hostKey.privateJwk, tokenEndpoint: tokenEndpoint(LINK.directoryUrl) })
const ORG_A: DelegationScope = { organizationId: 'org_a' }
const ORG_B: DelegationScope = { organizationId: 'org_b' }

const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
const instances: Delegations[] = []
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-delegations-'))
  process.env.SOLUS_DATA_DIR = dataDir
})
afterEach(() => {
  for (const instance of instances.splice(0)) instance.clear()
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

function delegations(fetchImpl: (form: URLSearchParams) => Promise<Response> | Response, options: { now?: () => number; revoked?: Array<[string, DelegationScope, DelegationRefusal, string[]]>; established?: Array<[string, DelegationScope]> } = {}) {
  const forms: URLSearchParams[] = []
  const headers: Headers[] = []
  const held: Delegations = new Delegations({
    registration: () => LINK,
    credential: () => credential,
    // What the host does on a refusal: it reads the sessions acting for the person to stop them.
    onRevoked: (userId, scope, refusal) => { options.revoked?.push([userId, scope, refusal, held.sessionsActingFor(userId, scope)]) },
    onEstablished: (userId, scope) => { options.established?.push([userId, scope]) },
    fetchImpl: async (_url, init) => {
      const form = init?.body as URLSearchParams
      forms.push(form)
      headers.push(new Headers(init?.headers))
      return fetchImpl(form)
    },
    now: options.now,
  })
  instances.push(held)
  return { held, forms, headers }
}

/** The claims of a client assertion whose signature the host's public key verifies; null for any other. */
function verifiedAssertion(assertion: string): { iss: string; sub: string; aud: string; jti: string; exp: number; iat: number } | null {
  const [header, body, signature] = assertion.split('.')
  if (!header || !body || !signature) return null
  const key = createPublicKey({ key: { ...hostKey.publicJwk }, format: 'jwk' })
  if (!verify('sha256', Buffer.from(`${header}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) return null
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
}

const answer = (token = 'access') => Response.json({ access_token: token, refresh_token: `refresh-${token}`, expires_in: 300 })
const outcome = (pending: Promise<unknown>) => pending.then(() => null, (error: Error) => error)

describe('making a delegation', () => {
  test('the host proves itself with a client assertion signed by its key, never a secret, at the exchange and at every refresh', async () => {
    // WHY: ADR 0001 §2.2 rule 8 — a host has one credential, its key (`private_key_jwt`, RFC 7523).
    let now = 0
    let issued = 0
    const { held, forms, headers } = delegations(() => answer(`access-${++issued}`), { now: () => now })
    await held.establish(presented('bob', 'g'), ORG_A)
    now = 10 * 60_000
    await held.accessToken('bob', ORG_A, { kind: 'api' })
    expect(forms).toHaveLength(2)
    const jtis = new Set<string>()
    for (const [index, form] of forms.entries()) {
      expect(headers[index]!.has('authorization')).toBe(false)
      expect(form.get('client_id')).toBe('host_host')
      expect(form.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE)
      const claims = verifiedAssertion(form.get('client_assertion')!)
      expect(claims).toMatchObject({ iss: 'host_host', sub: 'host_host', aud: tokenEndpoint(LINK.directoryUrl) })
      jtis.add(claims!.jti)
    }
    // Each assertion is used once.
    expect(jtis.size).toBe(2)
  })

  test('an unlinked host, with no key, sends nothing', async () => {
    const forms: URLSearchParams[] = []
    const unlinked = new Delegations({ registration: () => null, credential: () => null, onRevoked: () => {}, fetchImpl: async (_url, init) => { forms.push(init?.body as URLSearchParams); return answer() } })
    instances.push(unlinked)
    expect(await outcome(unlinked.establish(presented('bob', 'g'), ORG_A))).toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(forms).toHaveLength(0)
  })

  test('concurrent connections share one exchange, and a delegation held is not made again', async () => {
    const reply = deferred<Response>()
    const { held, forms } = delegations(() => reply.promise)
    const callers = Array.from({ length: 5 }, () => held.establish(presented('bob', 'grant_desktop'), ORG_A))
    reply.resolve(answer())
    await Promise.all(callers)
    await held.establish(presented('bob', 'grant_phone'), ORG_A)
    expect(forms).toHaveLength(1)
    expect(Object.fromEntries(forms[0]!)).toMatchObject({ subject_token: presented('bob', 'grant_desktop'), organization_id: 'org_a' })
    // The exchanged token is for both delegated resources; nothing is refreshed while it is good.
    expect(await held.accessToken('bob', ORG_A, { kind: 'api' })).toBe('access')
    expect(await held.accessToken('bob', ORG_A, { kind: 'account' })).toBe('access')
    expect(forms).toHaveLength(1)
  })

  test("the owner's personal delegation names no organization, and is apart from an organization's", async () => {
    let issued = 0
    const { held, forms } = delegations(() => answer(`access-${++issued}`))
    await held.establish(presented('alice', 'grant_desktop'), 'personal')
    await held.establish(presented('alice', 'grant_desktop'), ORG_A)
    expect(Object.fromEntries(forms[0]!)).toMatchObject({ delegation_scope: 'personal' })
    expect(forms[0]!.has('organization_id')).toBe(false)
    expect(held.holders()).toEqual([{ userId: 'alice', scope: 'personal' }, { userId: 'alice', scope: ORG_A }])
    expect(await held.accessToken('alice', 'personal', { kind: 'account' })).toBe('access-1')
    expect(await held.accessToken('alice', ORG_A, { kind: 'api' })).toBe('access-2')
  })

  test('a delegation made is announced once, so what waited on the account (an integration\'s cloud sign-in) is read again', async () => {
    // WHY: a host whose boot came before its owner's delegation listed an integration with
    // no token, and nothing listed it again: the agent never saw the integration's tools.
    const established: Array<[string, DelegationScope]> = []
    const { held } = delegations(() => answer(), { established })
    await held.establish(presented('alice', 'grant_desktop'), 'personal')
    await held.establish(presented('alice', 'grant_phone'), 'personal')
    expect(established).toEqual([['alice', 'personal']])
  })

  test('a token that names no person and grant makes nothing, and nothing is sent', async () => {
    const { held, forms } = delegations(() => answer())
    expect(await outcome(held.establish('not-a-jwt', 'personal'))).toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
    expect(forms).toHaveLength(0)
  })

  test('a failed exchange rejects every waiter and a later connection tries again', async () => {
    let mode: 'down' | 'up' = 'down'
    const { held, forms } = delegations(() => mode === 'down' ? Response.json({ error: 'unavailable' }, { status: 503 }) : answer())
    const errors = await Promise.all([outcome(held.establish(presented('bob', 'g'), ORG_A)), outcome(held.establish(presented('bob', 'g'), ORG_A))])
    expect(errors[0]).toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(errors[1]).toBe(errors[0])
    expect(held.has('bob', ORG_A)).toBe(false)
    mode = 'up'
    await held.establish(presented('bob', 'g'), ORG_A)
    expect(held.has('bob', ORG_A)).toBe(true)
    expect(forms).toHaveLength(2)
  })

  test('a turn that arrives while its connection makes the delegation waits for it', async () => {
    // WHY: the ticket door does not wait for the exchange; the first turn must not fail for that.
    const reply = deferred<Response>()
    const { held } = delegations(() => reply.promise)
    void held.establish(presented('bob', 'g'), ORG_A)
    const token = held.accessToken('bob', ORG_A, { kind: 'api' })
    reply.resolve(answer('first'))
    expect(await token).toBe('first')
    await expect(held.accessToken('carol', ORG_A, { kind: 'api' })).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
  })

  test('clearing rejects a late exchange without storing it; forgetting one person leaves the other', async () => {
    const late = deferred<Response>()
    // Bob's exchange is the late one, whichever reaches the endpoint first.
    const bobs = presented('bob', 'g')
    const { held } = delegations((form) => (form.get('subject_token') === bobs ? late.promise : answer()))
    const discarded = outcome(held.establish(bobs, ORG_A))
    await held.establish(presented('carol', 'g2'), ORG_A)
    held.forget('bob', ORG_A)
    late.resolve(answer('late'))
    expect(await discarded).toBeInstanceOf(Error)
    expect(held.has('bob', ORG_A)).toBe(false)
    expect(held.has('carol', ORG_A)).toBe(true)
    held.clear()
    expect(held.holders()).toEqual([])
  })
})

describe('refreshing a delegation', () => {
  test('each resource gets its own token, the refreshes run one at a time, and each rotated refresh token is used once', async () => {
    // WHY: ADR 0001 §2.2 rule 3 — one audience per token; a rotated refresh token used twice ends the family.
    let now = 1_000_000
    let issued = 0
    const { held, forms } = delegations((form) => {
      issued += 1
      return Response.json({ access_token: `${form.get('resource') ?? 'both'}-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 300 })
    }, { now: () => now })
    await held.establish(presented('bob', 'g'), ORG_A)
    now += 290_000
    const [api, account] = await Promise.all([held.accessToken('bob', ORG_A, { kind: 'api' }), held.accessToken('bob', ORG_A, { kind: 'account' })])
    expect(api).toBe(`${SOLUS_API_AUDIENCE}-2`)
    expect(account).toBe(`${ACCOUNT_AUDIENCE}-3`)
    expect(forms.slice(1).map((form) => ({ grant_type: form.get('grant_type'), refresh_token: form.get('refresh_token'), resource: form.get('resource') }))).toEqual([
      { grant_type: 'refresh_token', refresh_token: 'refresh-1', resource: SOLUS_API_AUDIENCE },
      { grant_type: 'refresh_token', refresh_token: 'refresh-2', resource: ACCOUNT_AUDIENCE },
    ])
  })

  test('the refresh tokens are kept by person and scope, and a restart resumes with them', async () => {
    let now = 1_000_000
    let issued = 0
    const cloud = (form: URLSearchParams) => Response.json({ access_token: `access-${++issued}`, refresh_token: `refresh-${issued}`, expires_in: 300, used: form.get('refresh_token') })
    const { held } = delegations(cloud, { now: () => now })
    await held.establish(presented('alice', 'g'), 'personal')
    await held.establish(presented('bob', 'g2'), ORG_A)
    const stored = JSON.parse(readFileSync(join(dataDir, 'secrets', 'delegations.json'), 'utf8'))
    expect(stored).toEqual({ version: 3, delegations: [
      { userId: 'alice', scope: 'personal', grantId: 'g', refreshToken: 'refresh-1' },
      { userId: 'bob', scope: { organizationId: 'org_a' }, grantId: 'g2', refreshToken: 'refresh-2' },
    ] })
    now += 400_000
    const restarted = delegations(cloud, { now: () => now })
    expect(restarted.held.holders()).toEqual([{ userId: 'alice', scope: 'personal' }, { userId: 'bob', scope: ORG_A }])
    expect(await restarted.held.accessToken('alice', 'personal', { kind: 'account' })).toBe('access-3')
    expect(restarted.forms[0]!.get('refresh_token')).toBe('refresh-1')
  })

  test('a file of the earlier format is discarded without harm: its people connect again', async () => {
    mkdirSync(join(dataDir, 'secrets'), { recursive: true })
    writeFileSync(join(dataDir, 'secrets', 'delegations.json'), JSON.stringify({ version: 1, refreshTokens: { 'org_a\u0000bob': 'old-refresh' } }))
    const { held } = delegations(() => answer())
    expect(held.holders()).toEqual([])
    await held.establish(presented('bob', 'g'), ORG_A)
    expect(JSON.parse(readFileSync(join(dataDir, 'secrets', 'delegations.json'), 'utf8')).version).toBe(3)
    held.clear()
    expect(existsSync(join(dataDir, 'secrets', 'delegations.json'))).toBe(false)
  })
})

describe('signing out', () => {
  test("a revoked client grant ends the person's work in that scope at the next refresh; a delegation from another grant goes on", async () => {
    // WHY: ADR 0001 §2.2 rule 5 — sign-out ends one client grant, and every delegation made
    // from it fails at its next refresh. Other clients of the same person continue.
    let now = 1_000_000
    const revokedGrants = new Set<string>()
    const grantOf = new Map<string, string>()
    let issued = 0
    // The account plane: each delegation is bound to the grant of the token it was made from.
    const cloud = (form: URLSearchParams) => {
      const grant = form.get('grant_type') === 'refresh_token'
        ? grantOf.get(form.get('refresh_token') ?? '')
        : JSON.parse(Buffer.from(form.get('subject_token')!.split('.')[1]!, 'base64url').toString('utf8')).grant_id
      if (!grant || revokedGrants.has(grant)) return Response.json({ error: 'invalid_grant', error_description: 'The sign-in this host acts for has ended.', solus_refusal: 'grant_revoked' }, { status: 400 })
      const refreshToken = `refresh-${++issued}`
      grantOf.set(refreshToken, grant)
      return Response.json({ access_token: `access-${issued}`, refresh_token: refreshToken, expires_in: 300 })
    }
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const { held } = delegations(cloud, { now: () => now, revoked })
    // Bob works in Acme from his desktop and in Beta from his phone; Alice owns the host.
    await held.establish(presented('bob', 'grant_desktop'), ORG_A)
    await held.establish(presented('bob', 'grant_phone'), ORG_B)
    await held.establish(presented('alice', 'grant_alice'), 'personal')
    held.bindSession('session-acme', { userId: 'bob', organizationId: 'org_a' })
    held.bindSession('session-beta', { userId: 'bob', organizationId: 'org_b' })

    revokedGrants.add('grant_desktop')
    // Until the token ends, nothing is asked; the next refresh is refused.
    expect(await held.accessToken('bob', ORG_A, { kind: 'api' })).toBe('access-1')
    now += 290_000
    await expect(held.accessToken('bob', ORG_A, { kind: 'api' })).rejects.toMatchObject({ code: 'GRANT_REVOKED' })
    // The host is told while it still knows which sessions acted for Bob in Acme, so it can stop them.
    expect(revoked).toEqual([['bob', ORG_A, 'GRANT_REVOKED', ['session-acme']]])
    expect(held.has('bob', ORG_A)).toBe(false)
    expect(held.actorOf('session-acme')).toBeNull()

    // His phone's delegation, and the owner's, go on.
    expect(await held.accessToken('bob', ORG_B, { kind: 'api' })).toBe('access-4')
    expect(await held.accessToken('alice', 'personal', { kind: 'account' })).toBe('access-5')
    expect(held.actorOf('session-beta')).toEqual({ userId: 'bob', organizationId: 'org_b' })
    // His next connection from a live client makes the Acme delegation again.
    await held.establish(presented('bob', 'grant_phone'), ORG_A)
    expect(held.has('bob', ORG_A)).toBe(true)
  })

  test('a sign-out in this process ends the delegations of that grant at once, as the refusal would; another grant’s go on', async () => {
    // WHY: ADR 0001 stage 6 — the desktop that hosts this server knows its own sign-out
    // at once. Its delegations end now, with the same effect as the account plane's
    // refusal at the next refresh; a delegation made from another client's grant stays.
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const { held, forms } = delegations(() => answer(), { revoked })
    await held.establish(presented('alice', 'grant_desktop'), 'personal')
    await held.establish(presented('alice', 'grant_desktop'), ORG_A)
    await held.establish(presented('alice', 'grant_phone'), ORG_B)
    held.bindSession('session-acme', { userId: 'alice', organizationId: 'org_a' })
    held.forgetGrant('grant_desktop')
    expect(revoked).toEqual([['alice', 'personal', 'GRANT_REVOKED', []], ['alice', ORG_A, 'GRANT_REVOKED', ['session-acme']]])
    expect(held.holders()).toEqual([{ userId: 'alice', scope: ORG_B }])
    // Nothing was asked of the account plane: the sign-out itself revokes the grant.
    expect(forms).toHaveLength(3)
    // The next restart reads only what is left.
    expect(delegations(() => answer()).held.holders()).toEqual([{ userId: 'alice', scope: ORG_B }])
  })

  test('another refusal of a refresh ends the work too, as a refusal of the organization', async () => {
    let now = 1_000_000
    let refuse = false
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const { held } = delegations(() => refuse ? Response.json({ error: 'invalid_grant', solus_refusal: 'not_a_member' }, { status: 400 }) : answer(), { now: () => now, revoked })
    await held.establish(presented('bob', 'g'), ORG_A)
    refuse = true
    now += 400_000
    await expect(held.accessToken('bob', ORG_A, { kind: 'api' })).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_REFUSED' })
    expect(revoked).toEqual([['bob', ORG_A, 'ORGANIZATION_ACCESS_REFUSED', []]])
  })
})

describe('a delegation derives from the sign-in', () => {
  // WHY: the host's delegation is made from the person's sign-in, not a second sign-in
  // of its own. A delegation the account plane will not refresh must not stay held: it
  // read as held, so nothing made it again, and the host told a signed-in person that
  // Solus Cloud was unreachable for hours. Only an outage keeps what is held.

  test('any refusal of a refresh ends the delegation, not only invalid_grant; an outage keeps it', async () => {
    let now = 1_000_000
    let reply: () => Response = () => answer()
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const { held } = delegations(() => reply(), { now: () => now, revoked })
    await held.establish(presented('alice', 'g'), 'personal')

    reply = () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
    now += 400_000
    await expect(held.accessToken('alice', 'personal', { kind: 'account' })).rejects.toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(held.has('alice', 'personal')).toBe(true)

    reply = () => Response.json({ error: 'invalid_request' }, { status: 400 })
    await expect(held.accessToken('alice', 'personal', { kind: 'account' })).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_REFUSED' })
    expect(held.has('alice', 'personal')).toBe(false)
    expect(revoked).toEqual([['alice', 'personal', 'ORGANIZATION_ACCESS_REFUSED', []]])
  })

  test('a 403 on a refresh ends the delegation too, and keeps its own code', async () => {
    let now = 1_000_000
    let refuse = false
    const { held } = delegations(() => refuse ? new Response(null, { status: 403 }) : answer(), { now: () => now })
    await held.establish(presented('bob', 'g'), ORG_A)
    refuse = true
    now += 400_000
    await expect(held.accessToken('bob', ORG_A, { kind: 'api' })).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
    expect(held.has('bob', ORG_A)).toBe(false)
  })

  test('a refused delegation is made again from the sign-in before the call fails, and the call gets its token', async () => {
    let now = 1_000_000
    let issued = 0
    let refuseRefresh = false
    const cloud = (form: URLSearchParams) => {
      if (form.get('grant_type') === 'refresh_token' && refuseRefresh) return Response.json({ error: 'invalid_request' }, { status: 400 })
      issued += 1
      return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 300 })
    }
    const renewals: Array<[string, DelegationScope]> = []
    let renew: (userId: string, scope: DelegationScope) => Promise<void> = async () => {}
    const held: Delegations = new Delegations({
      registration: () => LINK,
      credential: () => credential,
      onRevoked: () => {},
      // The signed-in desktop presents a fresh token: the host exchanges it again.
      renew: (userId, scope) => renew(userId, scope),
      fetchImpl: async (_url, init) => cloud(init?.body as URLSearchParams),
      now: () => now,
    })
    instances.push(held)
    renew = async (userId, scope) => {
      renewals.push([userId, scope])
      await held.establish(presented(userId, 'g2'), scope)
    }
    await held.establish(presented('alice', 'g1'), 'personal')
    refuseRefresh = true
    now += 400_000
    expect(await held.accessToken('alice', 'personal', { kind: 'account' })).toBe('access-2')
    expect(renewals).toEqual([['alice', 'personal']])
    expect(held.has('alice', 'personal')).toBe(true)
  })

  test('an outage is not renewed: the delegation stays and the call fails as unreachable', async () => {
    let now = 1_000_000
    let down = false
    let renewals = 0
    const held: Delegations = new Delegations({
      registration: () => LINK,
      credential: () => credential,
      onRevoked: () => {},
      renew: async () => { renewals += 1 },
      fetchImpl: async () => { if (down) throw new TypeError('fetch failed'); return answer() },
      now: () => now,
    })
    instances.push(held)
    await held.establish(presented('alice', 'g'), 'personal')
    down = true
    now += 400_000
    await expect(held.accessToken('alice', 'personal', { kind: 'account' })).rejects.toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(renewals).toBe(0)
    expect(held.has('alice', 'personal')).toBe(true)
  })

  test('a person with no delegation and no client that can make one fails as before', async () => {
    const held: Delegations = new Delegations({
      registration: () => LINK,
      credential: () => credential,
      onRevoked: () => {},
      renew: async () => {},
      fetchImpl: async () => answer(),
    })
    instances.push(held)
    await expect(held.accessToken('carol', 'personal', { kind: 'account' })).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
  })
})

describe('a token to reach another host (docs/plans/host-reach.md §3)', () => {
  test('is exchanged for the delegation\'s own token, kept for its eight hours, and its refusal leaves the delegation', async () => {
    // WHY: the account plane checks the reach when it issues the token and issues it
    // only by exchange; a host asking every five minutes would ask for nothing new, and
    // a host the person cannot reach must not end their work here. The token has that
    // host's own audience (docs/plans/simplify-auth-and-sync.md §3 rule 2).
    let now = 0
    let refuse = false
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const { held, forms } = delegations((form) => {
      if (form.get('resource') === 'urn:solus:host:far') {
        return refuse
          ? Response.json({ error: 'invalid_grant', solus_refusal: 'host_not_reachable', error_description: 'You do not reach that host.' }, { status: 400 })
          : Response.json({ access_token: 'reach-far', expires_in: 8 * 3600 })
      }
      return answer('delegated')
    }, { now: () => now, revoked })
    await held.establish(presented('alice', 'g'), 'personal')
    expect(await held.accessToken('alice', 'personal', { kind: 'host', hostId: 'far' })).toBe('reach-far')
    const exchange = forms.at(-1)!
    expect(Object.fromEntries([...exchange.entries()].filter(([name]) => !name.startsWith('client_')))).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'delegated',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      resource: 'urn:solus:host:far',
    })
    now = 7 * 3600_000
    expect(await held.accessToken('alice', 'personal', { kind: 'host', hostId: 'far' })).toBe('reach-far')
    expect(forms.filter((form) => form.get('resource') === 'urn:solus:host:far')).toHaveLength(1)
    refuse = true
    now = 9 * 3600_000
    const refused = await outcome(held.accessToken('alice', 'personal', { kind: 'host', hostId: 'far' }))
    expect(refused).toMatchObject({ code: 'HOST_NOT_REACHABLE' })
    expect(revoked).toEqual([])
    expect(held.has('alice', 'personal')).toBe(true)
  })
})
