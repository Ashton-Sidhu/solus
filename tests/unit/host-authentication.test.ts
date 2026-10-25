import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ACCESS_TOKEN_TYPE, CLIENT_ASSERTION_TYPE, TOKEN_EXCHANGE_GRANT_TYPE, tokenEndpoint, type EnrollHostResponse, type HostRegistration } from '@solus/contracts/uplink'
import { clientCredential, generateHostKey } from '@solus/server/host/host-credential'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// plans/009-organization-vms.md §4, §5: a self-hosted server's organization
// attachment is persisted with its registration before organization work is
// admitted, a person's own computer is never attached, and only the end of the
// registration resets the server to personal — the link plays no part
// (docs/adr/0001-standard-authentication.md §2.2 rule 9). A registered server
// redeems an organization code as an attachment, from its own account plane only.
//
// plans/010-standard-oauth.md: the host acts for a person with its own OAuth client
// and its key (docs/adr/0001-standard-authentication.md §3.4) — one token exchange
// with the token their client presented makes a delegation the account plane keeps;
// each later token is asked with the host's control token, the account plane's live
// check; nothing per prompt. A refused token ends the person's work here. The Solus
// API the link named is the only one it sends to.

const DIRECTORY = 'https://app.example.test'
/** The host's key, as its link manager holds it. */
const hostKey = await generateHostKey()
const API = 'https://api.example.test'
const HOST_ID = 'abcdefghijklmnop'

interface Call { method: string; url: string; body: unknown; authorization: string | null }

function recordingFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    const raw = input instanceof Request ? await input.text() : init?.body ? String(init.body) : ''
    const body = !raw ? null : raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
    const call = { method: (input instanceof Request ? input.method : init?.method) ?? 'GET', url, body, authorization: headers.get('authorization') }
    calls.push(call)
    return answer(call)
  }
  return { calls, fetchImpl }
}

const enrolled = (organizationIds?: string[]): EnrollHostResponse => ({
  registration: { hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY, generation: 1, apiUrl: API },
  oauthClient: { clientId: `host_${HOST_ID}` },
  ...(organizationIds ? { organizationIds } : {}),
})

describe('the organization attachment of a registered server', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  let registrationModule: typeof import('@solus/server/host/host-registration')
  let linkModule: typeof import('@solus/server/transport/uplink/link')
  let hostCategory: typeof import('@solus/server/host/host-category')

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-host-authentication-'))
    process.env.SOLUS_DATA_DIR = dataDir
    registrationModule = await import('@solus/server/host/host-registration')
    linkModule = await import('@solus/server/transport/uplink/link')
    hostCategory = await import('@solus/server/host/host-category')
    hostCategory.resetHostCategoryForTests()
    hostCategory.applyHostCategory('self-hosted')
  })

  afterEach(() => {
    hostCategory.resetHostCategoryForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  function registrar(fetchImpl: ReturnType<typeof recordingFetch>['fetchImpl']) {
    return new registrationModule.HostRegistrar({
      installationId: () => 'install-1', hostLabel: () => 'Lab VM', os: () => 'linux', owner: () => null, fetchImpl,
    })
  }

  const controlPlane = (options: { enroll?: () => EnrollHostResponse; attach?: () => Response; check?: () => Response } = {}) => recordingFetch((call) => {
    // The host's own control token (client credentials with its key) for its host routes.
    if (call.url === tokenEndpoint(DIRECTORY)) return Response.json({ access_token: 'control-token', expires_in: 300 })
    if (call.url.endsWith('/v1/hosts/enroll')) return Response.json(options.enroll?.() ?? enrolled())
    if (call.url.endsWith('/organizations/attach')) return options.attach?.() ?? Response.json({ organizationIds: ['org_a'] })
    if (call.method === 'DELETE' && call.url.includes('/organizations/')) return new Response(null, { status: 204 })
    if (call.url.endsWith('/link') && call.method === 'GET') return options.check?.() ?? Response.json({ hostId: HOST_ID, generation: 1, desired: 'linked', tunnel: { hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 } })
    if (call.url.endsWith('/link') && call.method === 'POST') return Response.json({ tunnel: { hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 }, connectorToken: 'connector-token-1' })
    if (call.url.endsWith('/link') && call.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('not found', { status: 404 })
  })

  test('a registration that attached organizations is persisted as attached; a restart keeps it; unlinking leaves it; only the end of the registration resets the server to personal', async () => {
    const plane = controlPlane({ enroll: () => enrolled(['org_a']) })
    const first = registrar(plane.fetchImpl)
    await first.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const attachedAt = first.attachedAt()
    expect(attachedAt).toBeNumber()
    expect(JSON.parse(readFileSync(join(dataDir, 'host-registration.json'), 'utf8'))).toMatchObject({ attachedAt, registration: { apiUrl: API } })
    // A restarted process reads the same boundary, before it admits anything.
    expect(registrar(plane.fetchImpl).attachedAt()).toBe(attachedAt)
    expect(registrationModule.readStoredRegistration()?.apiUrl).toBe(API)
    // The link turns the tunnel on and off, and nothing else.
    const tunnel = new linkModule.UplinkLinkManager({ registration: () => first.current(), controlToken: () => first.controlToken(), proxiedPort: () => 34118, connector: { start() {}, async stop() {} }, fetchImpl: plane.fetchImpl })
    await tunnel.link()
    await tunnel.unlink()
    expect(first.attachedAt()).toBe(attachedAt)
    // The owner deleted the host: the registration ends at the next check, and the attachment with it.
    const deleted = registrar(controlPlane({ check: () => Response.json({ error: 'invalid_host_credential' }, { status: 401 }) }).fetchImpl)
    await deleted.resume()
    expect(deleted.attachedAt()).toBeNull()
    expect(existsSync(join(dataDir, 'host-registration.json'))).toBe(false)
  })

  test('a person\'s own computer is never attached, whatever its registration says', async () => {
    hostCategory.applyHostCategory('personal')
    const instance = registrar(controlPlane({ enroll: () => enrolled(['org_a']) }).fetchImpl)
    await instance.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    expect(instance.attachedAt()).toBeNull()
    expect(instance.markAttached()).toBeNull()
  })

  test('a registered server redeems an organization code as an attachment, only from its own account plane; a removed organization leaves the attachment in place', async () => {
    const plane = controlPlane()
    const instance = registrar(plane.fetchImpl)
    await instance.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    expect(instance.attachedAt()).toBeNull()

    // A code from another account plane is refused before anything is sent there.
    await expect(instance.register({ ticket: 'set_elsewhere', directoryUrl: 'https://other.example.test', organizationIds: ['org_a'] })).rejects.toThrow(/registered to https:\/\/app.example.test/)
    expect(plane.calls.some((call) => call.url.startsWith('https://other.example.test'))).toBe(false)

    await instance.register({ ticket: 'set_org', directoryUrl: DIRECTORY, organizationIds: ['org_a'] })
    const attach = plane.calls.find((call) => call.url.endsWith('/organizations/attach'))
    expect(attach).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/organizations/attach`, body: { ticket: 'set_org' }, authorization: 'Bearer control-token' })
    expect(instance.attachedAt()).toBeNumber()

    // Taking one organization back does not make the server personal again (no automatic fallback).
    await instance.detach('org_a')
    expect(plane.calls.filter((call) => call.method === 'DELETE').at(-1)).toMatchObject({ method: 'DELETE', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/organizations/org_a`, authorization: 'Bearer control-token' })
    expect(instance.attachedAt()).toBeNumber()
  })

  test('a refused attachment says why and changes nothing', async () => {
    const plane = controlPlane({ attach: () => Response.json({ error: 'not_a_member' }, { status: 403 }) })
    const instance = registrar(plane.fetchImpl)
    await instance.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    await expect(instance.register({ ticket: 'set_org', directoryUrl: DIRECTORY, organizationIds: ['org_a'] })).rejects.toThrow(/no longer a member/)
    expect(instance.attachedAt()).toBeNull()
  })

  test('a registration that names an insecure Solus API is not stored', async () => {
    const insecure = enrolled()
    insecure.registration.apiUrl = 'http://api.example.test'
    const instance = registrar(controlPlane({ enroll: () => insecure }).fetchImpl)
    await expect(instance.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })).rejects.toThrow(/insecure address/)
    expect(existsSync(join(dataDir, 'host-registration.json'))).toBe(false)
  })
})

describe('the host acting for a person', () => {
  const LINK: HostRegistration = enrolled().registration
  const TOKEN_URL = `${DIRECTORY}/api/auth/oauth2/token`
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  let delegationsModule: typeof import('@solus/server/sync/delegations')

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-host-delegations-'))
    process.env.SOLUS_DATA_DIR = dataDir
    delegationsModule = await import('@solus/server/sync/delegations')
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  const DELEGATION_TOKEN_URL = `${DIRECTORY}/v1/hosts/${HOST_ID}/delegation-token`
  /** The account plane's token endpoint, its delegation-token route, and the Solus API. Every request is recorded; form bodies are read as forms. */
  function cloud(options: { token?: () => Response | Promise<Response>; admit?: () => Response } = {}) {
    let issued = 0
    const calls: Array<{ url: string; authorization: string | null; form: URLSearchParams | null; body: unknown }> = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      const form = init?.body instanceof URLSearchParams ? init.body : null
      calls.push({ url, authorization: headers.get('authorization'), form, body: form ? null : init?.body ? JSON.parse(String(init.body)) : null })
      if (url === TOKEN_URL) {
        issued += 1
        return Response.json({ access_token: `access-${issued}`, expires_in: 3600, token_type: 'Bearer' })
      }
      if (url === DELEGATION_TOKEN_URL) {
        if (options.token) return options.token()
        issued += 1
        return Response.json({ access_token: `access-${issued}`, expires_in: 3600, token_type: 'Bearer' })
      }
      if (url === `${API}/v1/session-admissions`) return options.admit?.() ?? Response.json({ sessionId: 'solus-1', organizationId: 'org_a', ownerKey: 'bob', hostId: HOST_ID, admittedAt: new Date(0).toISOString() }, { status: 201 })
      return new Response('not found', { status: 404 })
    }
    return { calls, fetchImpl }
  }

  function delegations(fetchImpl: ReturnType<typeof cloud>['fetchImpl'], options: { now?: () => number; revoked?: Array<[string, string]> } = {}) {
    return new delegationsModule.Delegations({
      registration: () => LINK,
      credential: () => credential,
      controlToken: async () => 'control-token',
      onRevoked: (userId, scope) => { options.revoked?.push([userId, scope === 'personal' ? scope : scope.organizationId]) },
      fetchImpl,
      now: options.now,
    })
  }

  const credential = clientCredential({ clientId: `host_${HOST_ID}`, privateJwk: hostKey.privateJwk, tokenEndpoint: TOKEN_URL })
  /** The fields of a token request a test reads; the client assertion is checked in `delegations.test.ts`. */
  const grantOf = (form: URLSearchParams) => Object.fromEntries([...form].filter(([name]) => !['client_id', 'client_assertion', 'client_assertion_type'].includes(name)))

  /** The access token Bob's client presented at this host's ticket door: his person and client grant. */
  const BOBS_TOKEN = `e30.${Buffer.from(JSON.stringify({ sub: 'bob', grant_id: 'grant_bob' })).toString('base64url')}.c2ln`

  test('the first organization turn trades the person\'s token for the host\'s own, and the API admits the session; later turns ask nobody', async () => {
    // WHY: nothing is asked of the account plane per prompt (plans/010-standard-oauth.md §1).
    const plane = cloud()
    const held = delegations(plane.fetchImpl)
    await held.establish(BOBS_TOKEN, { organizationId: 'org_a' })
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: true })
    // The delegated token is the API credential itself: no second credential is minted from it.
    expect(plane.calls.map((call) => call.url)).toEqual([TOKEN_URL, `${API}/v1/session-admissions`])
    const exchange = plane.calls[0]!
    // The host proves itself with an assertion its key signed, never a secret.
    expect(exchange.authorization).toBeNull()
    expect(exchange.form!.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE)
    expect(exchange.form!.get('client_id')).toBe(`host_${HOST_ID}`)
    expect(grantOf(exchange.form!)).toEqual({ grant_type: TOKEN_EXCHANGE_GRANT_TYPE, subject_token: BOBS_TOKEN, subject_token_type: ACCESS_TOKEN_TYPE, organization_id: 'org_a' })
    // The API credential is the delegated access token exchanged, never the host's own token.
    expect(plane.calls[1]!.authorization).toBe('Bearer access-1')
    expect(plane.calls[1]!.body).toMatchObject({ sessionId: 'solus-1' })
    // The next turns of the session, and its answers, reach nobody while the token is good.
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: false })
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: false })
    expect(plane.calls).toHaveLength(2)
    // Its tools find who they act for by the session id.
    expect(held.actorOf('solus-1')).toEqual({ userId: 'bob', organizationId: 'org_a' })
  })

  test('a person whose client never connected here cannot start organization work, and nothing is sent', async () => {
    const plane = cloud()
    await expect(delegations(plane.fetchImpl).actFor({ sessionId: 'solus-2', userId: 'mallory', organizationId: 'org_a', admit: true })).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
    expect(plane.calls).toEqual([])
  })

  test('a token about to run out is asked for again with the host\'s control token, and a restart needs nobody to connect', async () => {
    // WHY: runs and automations continue after every client closed and after the host restarts.
    let now = 1_000_000
    const plane = cloud()
    const held = delegations(plane.fetchImpl, { now: () => now })
    await held.establish(BOBS_TOKEN, { organizationId: 'org_a' })
    now += 3600_000 - 30_000
    expect(await held.accessToken('bob', { organizationId: 'org_a' }, { kind: 'api' })).toBe('access-2')
    expect(plane.calls[1]).toMatchObject({ url: DELEGATION_TOKEN_URL, authorization: 'Bearer control-token', body: { userId: 'bob', scope: { organizationId: 'org_a' }, resource: 'urn:solus:api' } })
    // A new process, and nobody connected: the record of whom it acts for is enough.
    const restarted = delegations(plane.fetchImpl, { now: () => now })
    expect(restarted.has('bob', { organizationId: 'org_a' })).toBe(true)
    expect(await restarted.accessToken('bob', { organizationId: 'org_a' }, { kind: 'api' })).toBe('access-3')
    expect(plane.calls.map((call) => call.url)).toEqual([TOKEN_URL, DELEGATION_TOKEN_URL, DELEGATION_TOKEN_URL])
  })

  test('a refused token ends the person\'s work here; an outage keeps a continuation going, never a new session', async () => {
    let now = 1_000_000
    let mode: 'ok' | 'down' | 'refused' = 'ok'
    const plane = cloud({ token: () => {
      if (mode === 'down') throw new TypeError('fetch failed')
      if (mode === 'refused') return Response.json({ error: 'access_denied', solus_refusal: 'not_a_member', error_description: 'The person is not a member of the organization.' }, { status: 403 })
      return Response.json({ access_token: 'access-later', expires_in: 3600 })
    } })
    const revoked: Array<[string, string]> = []
    const held = delegations(plane.fetchImpl, { now: () => now, revoked })
    await held.establish(BOBS_TOKEN, { organizationId: 'org_a' })
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: false })
    now += 2 * 3600_000
    mode = 'down'
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: false })
    await expect(held.actFor({ sessionId: 'solus-new', userId: 'bob', organizationId: 'org_a', admit: true })).rejects.toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(revoked).toEqual([])
    mode = 'refused'
    await expect(held.accessToken('bob', { organizationId: 'org_a' }, { kind: 'api' })).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_REFUSED', message: expect.stringContaining('not a member') })
    expect(revoked).toEqual([['bob', 'org_a']])
    expect(held.has('bob', { organizationId: 'org_a' })).toBe(false)
    expect(held.actorOf('solus-1')).toBeNull()
  })

  test('an API that refuses the admission prevents the start', async () => {
    const plane = cloud({ admit: () => Response.json({ error: { code: 'CONFLICT', message: 'This session was admitted for another person or host.', requestId: 'r1' } }, { status: 409 }) })
    const held = delegations(plane.fetchImpl)
    await held.establish(BOBS_TOKEN, { organizationId: 'org_a' })
    await expect(held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: true })).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_REFUSED' })
    expect(held.actorOf('solus-1')).toBeNull()
  })
})

describe('the Solus API a host delivers to is the one its registration named', () => {
  test('rows travel with their person\'s delegated token to the registration\'s API and nowhere else', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-host-authentication-delivery-'))
    const previousDataDir = process.env.SOLUS_DATA_DIR
    process.env.SOLUS_DATA_DIR = dataDir
    const delivery = await import('@solus/server/sync/runner-delivery')
    const queue = await import('@solus/server/sync/delivery-queue')
    const dbModule = await import('@solus/server/db')
    try {
      const plane = recordingFetch(() => Response.json({ lastSeq: 1, failed: [] }))
      queue.appendDelivery({ organizationId: 'org_a', actorUserId: 'bob' }, 'transcript', [{ key: 's-1:0', payload: { sessionId: 's-1', position: 0, message: {} } }])
      const runner = new delivery.RunnerDelivery({
        registration: () => enrolled().registration,
        delegations: { accessToken: async (userId, scope) => `delegated-${userId}-${scope.organizationId}` },
        owner: () => 'alice',
        fetchImpl: plane.fetchImpl,
        setTimeoutFn: ((fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 10))) as typeof setTimeout,
      })
      runner.start()
      for (let attempt = 0; attempt < 100 && queue.deliveryDestinations().length > 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
      await runner.stop()
      expect(plane.calls.map((call) => [new URL(call.url).origin, call.authorization])).toEqual([[API, 'Bearer delegated-bob-org_a']])
      expect(queue.deliveryDestinations()).toEqual([])
    } finally {
      dbModule.closeDb()
      rmSync(dataDir, { recursive: true, force: true })
      if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
      else process.env.SOLUS_DATA_DIR = previousDataDir
    }
  })
})
