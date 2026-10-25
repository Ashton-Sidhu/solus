import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPublicKey, verify } from 'crypto'
import { ACCOUNT_AUDIENCE, CLIENT_ASSERTION_TYPE, SOLUS_API_AUDIENCE, TOKEN_EXCHANGE_GRANT_TYPE, tokenEndpoint } from '@solus/contracts/uplink'
import { clientCredential, generateHostKey } from '@solus/server/host/host-credential'
import { Delegations, type DelegationRefusal, type DelegationScope, type DelegationsDeps } from '@solus/server/sync/delegations'

// docs/adr/0001-standard-authentication.md §2.2 rules 5 and 6, §3.4: a host acts for a
// person only through a delegation, made by token exchange from an access token their
// client presented here, for one scope (`personal` or one organization), and bound to
// that client's grant. The delegation is a row on the account plane: the host keeps no
// secret for it, and asks the account plane for each token with its own control token.
// A refusal of the grant ends the person's work in that scope only.

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
const grantOfSubject = (token: string): string => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).grant_id

const LINK = { hostId: 'host', issuer: 'https://account.test', jwksUrl: 'https://account.test/jwks', directoryUrl: 'https://account.test', generation: 1, apiUrl: 'https://api.test' }
const TOKEN_URL = tokenEndpoint(LINK.directoryUrl)
const DELEGATION_TOKEN_URL = `${LINK.directoryUrl}/v1/hosts/host/delegation-token`
/** The host's key: every exchange is authenticated with an assertion it signs (ADR 0001 §3.4). */
const hostKey = await generateHostKey()
const credential = clientCredential({ clientId: 'host_host', privateJwk: hostKey.privateJwk, tokenEndpoint: TOKEN_URL })
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

interface TokenAsk { userId: string; scope: DelegationScope; resource: string }
type Reply = Response | Promise<Response>

/**
 * The account plane: the exchange at its token endpoint (no refresh token), and the
 * delegation-token route. It keeps the delegation rows, each bound to its grant.
 */
function accountPlane(options: { exchange?: (form: URLSearchParams) => Reply | null; token?: (ask: TokenAsk) => Reply | null } = {}) {
  const exchanges: URLSearchParams[] = []
  const asks: Array<TokenAsk & { authorization: string | null }> = []
  const rows = new Map<string, string>()
  const revokedGrants = new Set<string>()
  const rowKey = (userId: string, scope: DelegationScope) => `${userId}\u0000${scope === 'personal' ? 'personal' : scope.organizationId}`
  let issued = 0
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url === TOKEN_URL) {
      const form = init?.body as URLSearchParams
      exchanges.push(form)
      const custom = options.exchange?.(form)
      if (custom) return custom
      const subject = form.get('subject_token')!
      const sub = JSON.parse(Buffer.from(subject.split('.')[1]!, 'base64url').toString('utf8')).sub as string
      const scope: DelegationScope = form.get('delegation_scope') === 'personal' ? 'personal' : { organizationId: form.get('organization_id')! }
      rows.set(rowKey(sub, scope), grantOfSubject(subject))
      return Response.json({ access_token: `exchanged-${++issued}`, token_type: 'Bearer', expires_in: 3600 })
    }
    if (url === DELEGATION_TOKEN_URL) {
      const ask = JSON.parse(String(init?.body)) as TokenAsk
      asks.push({ ...ask, authorization: new Headers(init?.headers).get('authorization') })
      const custom = options.token?.(ask)
      if (custom) return custom
      const grant = rows.get(rowKey(ask.userId, ask.scope))
      if (!grant) return Response.json({ error: 'no_delegation', solus_refusal: 'no_delegation' }, { status: 403 })
      if (revokedGrants.has(grant)) return Response.json({ error: 'grant_revoked', error_description: 'The sign-in this host acts for has ended.', solus_refusal: 'grant_revoked' }, { status: 403 })
      return Response.json({ access_token: `${ask.resource}-${++issued}`, token_type: 'Bearer', expires_in: 3600 })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, exchanges, asks, rows, revokedGrants }
}

function delegations(plane: ReturnType<typeof accountPlane>, options: { now?: () => number; revoked?: Array<[string, DelegationScope, DelegationRefusal, string[]]>; established?: Array<[string, DelegationScope]>; renew?: DelegationsDeps['renew'] } = {}) {
  const held: Delegations = new Delegations({
    registration: () => LINK,
    credential: () => credential,
    controlToken: async () => 'control-token',
    // What the host does on a refusal: it reads the sessions acting for the person to stop them.
    onRevoked: (userId, scope, refusal) => { options.revoked?.push([userId, scope, refusal, held.sessionsActingFor(userId, scope)]) },
    onEstablished: (userId, scope) => { options.established?.push([userId, scope]) },
    renew: options.renew,
    fetchImpl: plane.fetchImpl,
    now: options.now,
  })
  instances.push(held)
  return held
}

/** The claims of a client assertion whose signature the host's public key verifies; null for any other. */
function verifiedAssertion(assertion: string): { iss: string; sub: string; aud: string; jti: string; exp: number; iat: number } | null {
  const [header, body, signature] = assertion.split('.')
  if (!header || !body || !signature) return null
  const key = createPublicKey({ key: { ...hostKey.publicJwk }, format: 'jwk' })
  if (!verify('sha256', Buffer.from(`${header}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) return null
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
}

const outcome = (pending: Promise<unknown>) => pending.then(() => null, (error: Error) => error)
/** Every file under the data directory, with its text. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [readFileSync(path, 'utf8')]
  })
}

describe('making a delegation', () => {
  test('the exchange is proved with a client assertion signed by the host key; a token after it is asked with the control token', async () => {
    // WHY: ADR 0001 §2.2 rule 8 — a host has one credential, its key (`private_key_jwt`,
    // RFC 7523), and the control token it gets with it. No person's token or secret goes in a body.
    let now = 0
    const plane = accountPlane()
    const held = delegations(plane, { now: () => now })
    await held.establish(presented('bob', 'g'), ORG_A)
    const form = plane.exchanges[0]!
    expect(Object.fromEntries([...form].filter(([name]) => !name.startsWith('client_')))).toEqual({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: presented('bob', 'g'),
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      organization_id: 'org_a',
    })
    expect(form.get('client_id')).toBe('host_host')
    expect(form.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE)
    expect(verifiedAssertion(form.get('client_assertion')!)).toMatchObject({ iss: 'host_host', sub: 'host_host', aud: TOKEN_URL })
    now = 2 * 3600_000
    expect(await held.accessToken('bob', ORG_A, { kind: 'api' })).toBe(`${SOLUS_API_AUDIENCE}-2`)
    expect(plane.asks).toEqual([{ userId: 'bob', scope: ORG_A, resource: SOLUS_API_AUDIENCE, authorization: 'Bearer control-token' }])
  })

  test('an unregistered host, with no key, sends nothing', async () => {
    const plane = accountPlane()
    const unlinked = new Delegations({ registration: () => null, credential: () => null, controlToken: async () => 'control-token', onRevoked: () => {}, fetchImpl: plane.fetchImpl })
    instances.push(unlinked)
    expect(await outcome(unlinked.establish(presented('bob', 'g'), ORG_A))).toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(plane.exchanges).toHaveLength(0)
  })

  test('concurrent connections share one exchange, a delegation held is not made again, and its token serves both our servers', async () => {
    const reply = deferred<Response>()
    const plane = accountPlane({ exchange: () => reply.promise })
    const held = delegations(plane)
    const callers = Array.from({ length: 5 }, () => held.establish(presented('bob', 'grant_desktop'), ORG_A))
    reply.resolve(Response.json({ access_token: 'exchanged', token_type: 'Bearer', expires_in: 3600 }))
    await Promise.all(callers)
    await held.establish(presented('bob', 'grant_phone'), ORG_A)
    expect(plane.exchanges).toHaveLength(1)
    expect(await held.accessToken('bob', ORG_A, { kind: 'api' })).toBe('exchanged')
    expect(await held.accessToken('bob', ORG_A, { kind: 'account' })).toBe('exchanged')
    expect(plane.asks).toHaveLength(0)
  })

  test("the owner's personal delegation names no organization, and is apart from an organization's", async () => {
    const plane = accountPlane()
    const held = delegations(plane)
    await held.establish(presented('alice', 'grant_desktop'), 'personal')
    await held.establish(presented('alice', 'grant_desktop'), ORG_A)
    expect(Object.fromEntries(plane.exchanges[0]!)).toMatchObject({ delegation_scope: 'personal' })
    expect(plane.exchanges[0]!.has('organization_id')).toBe(false)
    expect(held.holders()).toEqual([{ userId: 'alice', scope: 'personal' }, { userId: 'alice', scope: ORG_A }])
    expect(await held.accessToken('alice', 'personal', { kind: 'account' })).toBe('exchanged-1')
    expect(await held.accessToken('alice', ORG_A, { kind: 'api' })).toBe('exchanged-2')
  })

  test('a delegation made is announced once, so what waited on the account (an integration\'s cloud sign-in) is read again', async () => {
    // WHY: a host whose boot came before its owner's delegation listed an integration with
    // no token, and nothing listed it again: the agent never saw the integration's tools.
    const established: Array<[string, DelegationScope]> = []
    const held = delegations(accountPlane(), { established })
    await held.establish(presented('alice', 'grant_desktop'), 'personal')
    await held.establish(presented('alice', 'grant_phone'), 'personal')
    expect(established).toEqual([['alice', 'personal']])
  })

  test('a token that names no person and grant makes nothing, and nothing is sent', async () => {
    const plane = accountPlane()
    const held = delegations(plane)
    expect(await outcome(held.establish('not-a-jwt', 'personal'))).toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
    expect(plane.exchanges).toHaveLength(0)
  })

  test('a failed exchange rejects every waiter and a later connection tries again', async () => {
    let down = true
    const plane = accountPlane({ exchange: () => down ? Response.json({ error: 'unavailable' }, { status: 503 }) : null })
    const held = delegations(plane)
    const errors = await Promise.all([outcome(held.establish(presented('bob', 'g'), ORG_A)), outcome(held.establish(presented('bob', 'g'), ORG_A))])
    expect(errors[0]).toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(errors[1]).toBe(errors[0])
    expect(held.has('bob', ORG_A)).toBe(false)
    down = false
    await held.establish(presented('bob', 'g'), ORG_A)
    expect(held.has('bob', ORG_A)).toBe(true)
    expect(plane.exchanges).toHaveLength(2)
  })

  test('a turn that arrives while its connection makes the delegation waits for it', async () => {
    // WHY: the ticket door does not wait for the exchange; the first turn must not fail for that.
    const reply = deferred<Response>()
    const held = delegations(accountPlane({ exchange: () => reply.promise }))
    void held.establish(presented('bob', 'g'), ORG_A)
    const token = held.accessToken('bob', ORG_A, { kind: 'api' })
    reply.resolve(Response.json({ access_token: 'first', token_type: 'Bearer', expires_in: 3600 }))
    expect(await token).toBe('first')
    await expect(held.accessToken('carol', ORG_A, { kind: 'api' })).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
  })

  test('clearing rejects a late exchange without storing it; forgetting one person leaves the other', async () => {
    const late = deferred<Response>()
    // Bob's exchange is the late one, whichever reaches the endpoint first.
    const bobs = presented('bob', 'g')
    const held = delegations(accountPlane({ exchange: (form) => form.get('subject_token') === bobs ? late.promise : null }))
    const discarded = outcome(held.establish(bobs, ORG_A))
    await held.establish(presented('carol', 'g2'), ORG_A)
    held.forget('bob', ORG_A)
    late.resolve(Response.json({ access_token: 'late', token_type: 'Bearer', expires_in: 3600 }))
    expect(await discarded).toBeInstanceOf(Error)
    expect(held.has('bob', ORG_A)).toBe(false)
    expect(held.has('carol', ORG_A)).toBe(true)
    held.clear()
    expect(held.holders()).toEqual([])
  })
})

describe('a token for a delegation', () => {
  test('costs one request per resource, is kept until a minute before its end, and concurrent asks share that request', async () => {
    // WHY: a token is the account plane's live check, not a rotation: no queue, and no
    // second request while one is in flight or the token is good.
    let now = 0
    const reply = deferred<Response>()
    let isAnswered = false
    const plane = accountPlane({ token: (ask) => {
      if (isAnswered || ask.resource !== SOLUS_API_AUDIENCE) return null
      isAnswered = true
      return reply.promise
    } })
    const held = delegations(plane, { now: () => now })
    await held.establish(presented('bob', 'g'), ORG_A)
    now = 3600_000 - 30_000
    const api = Array.from({ length: 5 }, () => held.accessToken('bob', ORG_A, { kind: 'api' }))
    const account = held.accessToken('bob', ORG_A, { kind: 'account' })
    reply.resolve(Response.json({ access_token: 'api-token', token_type: 'Bearer', expires_in: 3600 }))
    expect(await Promise.all(api)).toEqual(Array(5).fill('api-token'))
    expect(await account).toBe(`${ACCOUNT_AUDIENCE}-2`)
    expect(plane.asks.map((ask) => ask.resource)).toEqual([SOLUS_API_AUDIENCE, ACCOUNT_AUDIENCE])
    now += 3600_000 - 61_000
    expect(await held.accessToken('bob', ORG_A, { kind: 'api' })).toBe('api-token')
    now += 2_000
    expect(await held.accessToken('bob', ORG_A, { kind: 'api' })).toBe(`${SOLUS_API_AUDIENCE}-3`)
    expect(plane.asks).toHaveLength(3)
  })

  test('nothing secret is stored: a restart knows whom it acts for, and one request gets its token', async () => {
    // WHY: the account plane keeps the delegation; the host keeps only whom it acts for,
    // so a restart resumes work (an automation included) without anyone reconnecting.
    const plane = accountPlane()
    const held = delegations(plane)
    await held.establish(presented('alice', 'g'), 'personal')
    await held.establish(presented('bob', 'g2'), ORG_A)
    expect(JSON.parse(readFileSync(join(dataDir, 'delegations.json'), 'utf8'))).toEqual({ version: 4, delegations: [
      { userId: 'alice', scope: 'personal', grantId: 'g' },
      { userId: 'bob', scope: { organizationId: 'org_a' }, grantId: 'g2' },
    ] })
    // No token the host was given or presented is anywhere on disk.
    for (const text of filesUnder(dataDir)) {
      for (const secret of ['exchanged-1', 'exchanged-2', presented('alice', 'g'), presented('bob', 'g2')]) expect(text).not.toContain(secret)
    }
    const restarted = delegations(plane)
    expect(restarted.holders()).toEqual([{ userId: 'alice', scope: 'personal' }, { userId: 'bob', scope: ORG_A }])
    expect(await restarted.accessToken('alice', 'personal', { kind: 'account' })).toBe(`${ACCOUNT_AUDIENCE}-3`)
    expect(plane.asks).toHaveLength(1)
    expect(plane.exchanges).toHaveLength(2)
  })

  test('a record of an earlier format is discarded without harm, and clearing removes the record', async () => {
    writeFileSync(join(dataDir, 'delegations.json'), JSON.stringify({ version: 3, delegations: [{ userId: 'bob', scope: 'personal', grantId: 'g', refreshToken: 'old' }] }))
    const held = delegations(accountPlane())
    expect(held.holders()).toEqual([])
    await held.establish(presented('bob', 'g'), ORG_A)
    expect(JSON.parse(readFileSync(join(dataDir, 'delegations.json'), 'utf8')).version).toBe(4)
    held.clear()
    expect(existsSync(join(dataDir, 'delegations.json'))).toBe(false)
  })

  test('a token for another host is asked through the same route, with that host\'s audience, and kept like any other', async () => {
    // WHY: host reach is one more resource of the delegation (simplify-auth-and-sync §3
    // rule 2): no second exchange, no second mechanism.
    const plane = accountPlane()
    const held = delegations(plane)
    await held.establish(presented('alice', 'g'), 'personal')
    expect(await held.accessToken('alice', 'personal', { kind: 'host', hostId: 'far' })).toBe('urn:solus:host:far-2')
    expect(await held.accessToken('alice', 'personal', { kind: 'host', hostId: 'far' })).toBe('urn:solus:host:far-2')
    expect(plane.asks).toEqual([{ userId: 'alice', scope: 'personal', resource: 'urn:solus:host:far', authorization: 'Bearer control-token' }])
    expect(plane.exchanges).toHaveLength(1)
  })

  test('a refused host reach names one host: the delegation stays', async () => {
    for (const reason of ['host_not_ready', 'host_not_reachable', 'host_outside_organization']) {
      const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
      const plane = accountPlane({ token: (ask) => ask.resource === 'urn:solus:host:far'
        ? Response.json({ error: 'invalid_grant', solus_refusal: reason, error_description: 'Not that host.' }, { status: 403 })
        : null })
      const held = delegations(plane, { revoked })
      await held.establish(presented('alice', 'g'), 'personal')
      expect(await outcome(held.accessToken('alice', 'personal', { kind: 'host', hostId: 'far' }))).toMatchObject({ code: 'HOST_NOT_REACHABLE' })
      expect(revoked).toEqual([])
      expect(held.has('alice', 'personal')).toBe(true)
    }
  })
})

describe('signing out', () => {
  test("a revoked client grant ends the person's work in that scope at the next token; a delegation from another grant goes on", async () => {
    // WHY: ADR 0001 §2.2 rule 5 — sign-out ends one client grant, and every delegation made
    // from it fails at its next token. Other clients of the same person continue.
    let now = 0
    const plane = accountPlane()
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const held = delegations(plane, { now: () => now, revoked })
    // Bob works in Acme from his desktop and in Beta from his phone; Alice owns the host.
    await held.establish(presented('bob', 'grant_desktop'), ORG_A)
    await held.establish(presented('bob', 'grant_phone'), ORG_B)
    await held.establish(presented('alice', 'grant_alice'), 'personal')
    held.bindSession('session-acme', { userId: 'bob', organizationId: 'org_a' })
    held.bindSession('session-beta', { userId: 'bob', organizationId: 'org_b' })

    plane.revokedGrants.add('grant_desktop')
    // Until the token ends, nothing is asked; the next ask is refused.
    expect(await held.accessToken('bob', ORG_A, { kind: 'api' })).toBe('exchanged-1')
    now = 2 * 3600_000
    await expect(held.accessToken('bob', ORG_A, { kind: 'api' })).rejects.toMatchObject({ code: 'GRANT_REVOKED' })
    // The host is told while it still knows which sessions acted for Bob in Acme, so it can stop them.
    expect(revoked).toEqual([['bob', ORG_A, 'GRANT_REVOKED', ['session-acme']]])
    expect(held.has('bob', ORG_A)).toBe(false)
    expect(held.actorOf('session-acme')).toBeNull()

    // His phone's delegation, and the owner's, go on.
    expect(await held.accessToken('bob', ORG_B, { kind: 'api' })).toBe(`${SOLUS_API_AUDIENCE}-4`)
    expect(await held.accessToken('alice', 'personal', { kind: 'account' })).toBe(`${ACCOUNT_AUDIENCE}-5`)
    expect(held.actorOf('session-beta')).toEqual({ userId: 'bob', organizationId: 'org_b' })
    // His next connection from a live client makes the Acme delegation again.
    await held.establish(presented('bob', 'grant_phone'), ORG_A)
    expect(held.has('bob', ORG_A)).toBe(true)
  })

  test('a sign-out in this process ends the delegations of that grant at once, as the refusal would; another grant’s go on', async () => {
    // WHY: ADR 0001 stage 6 — the desktop that hosts this server knows its own sign-out
    // at once. Its delegations end now, with the same effect as the account plane's
    // refusal at the next token; a delegation made from another client's grant stays.
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const plane = accountPlane()
    const held = delegations(plane, { revoked })
    await held.establish(presented('alice', 'grant_desktop'), 'personal')
    await held.establish(presented('alice', 'grant_desktop'), ORG_A)
    await held.establish(presented('alice', 'grant_phone'), ORG_B)
    held.bindSession('session-acme', { userId: 'alice', organizationId: 'org_a' })
    held.forgetGrant('grant_desktop')
    expect(revoked).toEqual([['alice', 'personal', 'GRANT_REVOKED', []], ['alice', ORG_A, 'GRANT_REVOKED', ['session-acme']]])
    expect(held.holders()).toEqual([{ userId: 'alice', scope: ORG_B }])
    // Nothing more was asked of the account plane: the sign-out itself revokes the grant.
    expect(plane.exchanges).toHaveLength(3)
    expect(plane.asks).toHaveLength(0)
    // The next restart reads only what is left.
    expect(delegations(plane).holders()).toEqual([{ userId: 'alice', scope: ORG_B }])
  })

  test('a refusal of membership ends the work too, as a refusal of the organization', async () => {
    let now = 0
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const plane = accountPlane({ token: () => Response.json({ error: 'access_denied', solus_refusal: 'not_a_member' }, { status: 403 }) })
    const held = delegations(plane, { now: () => now, revoked })
    await held.establish(presented('bob', 'g'), ORG_A)
    now = 2 * 3600_000
    await expect(held.accessToken('bob', ORG_A, { kind: 'api' })).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_REFUSED' })
    expect(revoked).toEqual([['bob', ORG_A, 'ORGANIZATION_ACCESS_REFUSED', []]])
    expect(held.has('bob', ORG_A)).toBe(false)
  })

  test('an outage keeps the delegation and fails the call as unreachable', async () => {
    let now = 0
    let down = false
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const plane = accountPlane({ token: () => down ? Response.json({ error: 'temporarily_unavailable' }, { status: 503 }) : null })
    const held = delegations(plane, { now: () => now, revoked })
    await held.establish(presented('alice', 'g'), 'personal')
    down = true
    now = 2 * 3600_000
    await expect(held.accessToken('alice', 'personal', { kind: 'account' })).rejects.toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(held.has('alice', 'personal')).toBe(true)
    expect(revoked).toEqual([])
  })
})

describe('a delegation the account plane does not hold', () => {
  test('is made again from the person\'s presented token before the call fails, and the call gets its token', async () => {
    // WHY: the account plane may hold no row for a delegation this host remembers (its
    // data was reset, or the row went). While the person is signed in, the host acts for them.
    let now = 0
    const plane = accountPlane()
    const renewals: Array<[string, DelegationScope]> = []
    const revoked: Array<[string, DelegationScope, DelegationRefusal, string[]]> = []
    const held: Delegations = delegations(plane, {
      now: () => now,
      revoked,
      // The signed-in desktop presents a fresh token: the host exchanges it again.
      renew: async (userId, scope) => {
        renewals.push([userId, scope])
        await held.establish(presented(userId, 'g2'), scope)
      },
    })
    await held.establish(presented('alice', 'g1'), 'personal')
    plane.rows.clear()
    now = 2 * 3600_000
    expect(await held.accessToken('alice', 'personal', { kind: 'account' })).toBe('exchanged-2')
    expect(renewals).toEqual([['alice', 'personal']])
    expect(plane.exchanges.map((form) => form.get('subject_token'))).toEqual([presented('alice', 'g1'), presented('alice', 'g2')])
    expect(held.has('alice', 'personal')).toBe(true)
    // The person's work did not end: the delegation was missing, not refused.
    expect(revoked).toEqual([])
  })

  test('with no client that can present, the call fails and the host no longer counts the person as held', async () => {
    let now = 0
    const plane = accountPlane()
    const held = delegations(plane, { now: () => now, renew: async () => {} })
    await held.establish(presented('alice', 'g'), 'personal')
    plane.rows.clear()
    now = 2 * 3600_000
    await expect(held.accessToken('alice', 'personal', { kind: 'account' })).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
    expect(held.has('alice', 'personal')).toBe(false)
    await expect(held.accessToken('carol', 'personal', { kind: 'account' })).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
  })

  test('a revoked grant is not renewed: the work ends', async () => {
    let now = 0
    let renewals = 0
    const plane = accountPlane()
    const held = delegations(plane, { now: () => now, renew: async () => { renewals += 1 } })
    await held.establish(presented('alice', 'g'), 'personal')
    plane.revokedGrants.add('g')
    now = 2 * 3600_000
    await expect(held.accessToken('alice', 'personal', { kind: 'account' })).rejects.toMatchObject({ code: 'GRANT_REVOKED' })
    expect(renewals).toBe(0)
  })
})
