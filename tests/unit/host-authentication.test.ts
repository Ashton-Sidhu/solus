import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ACCESS_TOKEN_TYPE, CLIENT_ASSERTION_TYPE, TOKEN_EXCHANGE_GRANT_TYPE, tokenEndpoint, type EnrollHostResponse, type HostRegistration } from '@solus/contracts/uplink'
import { clientCredential, generateHostKey } from '@solus/server/host/host-credential'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// plans/034-one-cloud-machine-kind.md §2, §3: a server that registers with an
// organization code is a cloud machine of that organization. The registration names
// the organization, and nothing else makes a cloud machine: not the address of the
// machine, which only says how the internet reaches it. The code is refused on a
// server that is registered already or that holds sessions, before its one-use ticket
// is sent: a cloud machine starts with new data. A cloud machine stays one: the link
// plays no part (docs/adr/0001-standard-authentication.md §2.2 rule 9), and the end
// of its registration leaves the record of its organization in the data directory.
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
/** The machine's own HTTPS address, as its operator gave it with the code. */
const ADDRESS = 'https://vm.example.test'

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

/** What the control plane answers: a personal registration, or a cloud machine's when the ticket named an organization. */
const enrolled = (organizationId?: string): EnrollHostResponse => ({
  registration: { hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY, generation: 1, ...(organizationId ? { organizationId } : {}), apiUrl: API },
  oauthClient: { clientId: `host_${HOST_ID}` },
})

describe('the registration of a cloud machine', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  let registrationModule: typeof import('@solus/server/host/host-registration')
  let linkModule: typeof import('@solus/server/transport/uplink/link')
  let machine: typeof import('@solus/server/host/machine-kind')

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-host-authentication-'))
    process.env.SOLUS_DATA_DIR = dataDir
    registrationModule = await import('@solus/server/host/host-registration')
    linkModule = await import('@solus/server/transport/uplink/link')
    machine = await import('@solus/server/host/machine-kind')
    machine.resetMachineKindForTests()
  })

  afterEach(() => {
    machine.resetMachineKindForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  /** A registrar as the boot composes it: each registration change names the machine's kind again. */
  function registrar(fetchImpl: ReturnType<typeof recordingFetch>['fetchImpl'], holdsWork?: () => Promise<boolean>) {
    return new registrationModule.HostRegistrar({
      installationId: () => 'install-1', hostLabel: () => 'Lab VM', os: () => 'linux', owner: () => null, fetchImpl, holdsWork,
      onRegistrationChanged: (registration) => machine.adoptRegistration(registration),
    })
  }

  const controlPlane = (options: { enroll?: () => EnrollHostResponse | Response; check?: () => Response } = {}) => recordingFetch((call) => {
    // The host's own control token (client credentials with its key) for its host routes.
    if (call.url === tokenEndpoint(DIRECTORY)) return Response.json({ access_token: 'control-token', expires_in: 300 })
    if (call.url.endsWith('/v1/hosts/enroll')) {
      const answer = options.enroll?.() ?? enrolled()
      return answer instanceof Response ? answer : Response.json(answer)
    }
    if (call.url.endsWith('/link') && call.method === 'GET') return options.check?.() ?? Response.json({ hostId: HOST_ID, generation: 1, desired: 'linked', tunnel: { hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 } })
    if (call.url.endsWith('/link') && call.method === 'POST') return Response.json({ tunnel: { hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 }, connectorToken: 'connector-token-1' })
    if (call.url.endsWith('/link') && call.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('not found', { status: 404 })
  })
  const enrollCalls = (plane: ReturnType<typeof controlPlane>) => plane.calls.filter((call) => call.url.endsWith('/v1/hosts/enroll'))

  test('an organization code registers a cloud machine: the ticket goes with the machine\'s address, the server is a cloud machine at once, a restart reads it, and neither an unlink nor the end of the registration makes it personal again', async () => {
    const plane = controlPlane({ enroll: () => enrolled('org_a') })
    const first = registrar(plane.fetchImpl)
    expect(machine.machineKind()).toBe('personal')
    await first.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY, address: ADDRESS })
    expect(enrollCalls(plane)).toHaveLength(1)
    expect(enrollCalls(plane)[0]).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/enroll`, body: { ticket: 'org_ticket', address: ADDRESS, installationId: 'install-1' } })
    // The server does not say what it is: the control plane decides the kind from the ticket.
    expect(enrollCalls(plane)[0]!.body).not.toHaveProperty('category')
    // WHY: the pairing door and the trusted network position must close with no restart.
    expect(machine.machineKind()).toBe('cloud')
    expect(machine.cloudOrganizationId()).toBe('org_a')
    expect(JSON.parse(readFileSync(join(dataDir, 'host-registration.json'), 'utf8'))).toEqual({ version: 1, registration: enrolled('org_a').registration })
    // A restarted process reads the same registration, before anything listens.
    machine.resetMachineKindForTests()
    machine.adoptRegistration(registrationModule.readStoredRegistration())
    expect(machine.machineKind()).toBe('cloud')
    expect(registrationModule.readStoredRegistration()?.apiUrl).toBe(API)
    // The link turns the machine's reach on and off, and nothing else.
    const tunnel = new linkModule.UplinkLinkManager({ registration: () => first.current(), controlToken: () => first.controlToken(), proxiedPort: () => 34118, connector: { start() {}, async stop() {} }, fetchImpl: plane.fetchImpl })
    await tunnel.link()
    await tunnel.unlink()
    expect(first.current()?.organizationId).toBe('org_a')
    expect(machine.machineKind()).toBe('cloud')
    // The machine was deleted in Solus cloud: the registration ends at the next check. The kind does not.
    // WHY: the sessions on this disk are the organization's. A personal machine has a pairing door and a local owner.
    const deleted = registrar(controlPlane({ check: () => Response.json({ error: 'invalid_host_credential' }, { status: 401 }) }).fetchImpl)
    await deleted.resume()
    expect(deleted.current()).toBeNull()
    expect(existsSync(join(dataDir, 'host-registration.json'))).toBe(false)
    expect(machine.machineKind()).toBe('cloud')
    expect(machine.cloudOrganizationId()).toBe('org_a')
    // The next boot has no registration to read. It adopts what the data directory remembers, as `adoptStartupRegistration` does.
    machine.resetMachineKindForTests()
    machine.adoptRegistration(registrationModule.readStoredCloudMachine())
    machine.adoptRegistration(registrationModule.readStoredRegistration())
    expect(machine.machineKind()).toBe('cloud')
    expect(machine.cloudOrganizationId()).toBe('org_a')
    expect(machine.hasManagedCompute()).toBe(false)
  })

  test('an organization code with no address registers a cloud machine all the same: the ticket decides, not the address', async () => {
    const plane = controlPlane({ enroll: () => enrolled('org_a') })
    const instance = registrar(plane.fetchImpl)
    await instance.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY })
    expect(enrollCalls(plane)[0]!.body).toMatchObject({ ticket: 'org_ticket' })
    expect(enrollCalls(plane)[0]!.body).not.toHaveProperty('address')
    expect(machine.machineKind()).toBe('cloud')
    expect(machine.cloudOrganizationId()).toBe('org_a')
  })

  test('a personal code registers a personal machine, also for a standalone server, with its address or with none', async () => {
    // WHY: a standalone server is not a machine kind. Nothing but an organization in the registration makes a cloud machine.
    const plane = controlPlane()
    const instance = registrar(plane.fetchImpl)
    await instance.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    expect(enrollCalls(plane)[0]!.body).toMatchObject({ ticket: 'set_ticket' })
    expect(enrollCalls(plane)[0]!.body).not.toHaveProperty('address')
    expect(enrollCalls(plane)[0]!.body).not.toHaveProperty('category')
    expect(instance.current()).not.toHaveProperty('organizationId')
    expect(machine.machineKind()).toBe('personal')
    expect(registrationModule.readStoredCloudMachine()).toBeNull()
  })

  test('a personal code with an address registers a personal machine: the address says how it is reached, not what it is', async () => {
    const plane = controlPlane()
    const instance = registrar(plane.fetchImpl)
    await instance.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY, address: ADDRESS })
    expect(enrollCalls(plane)[0]!.body).toMatchObject({ ticket: 'set_ticket', address: ADDRESS })
    expect(instance.current()).not.toHaveProperty('organizationId')
    expect(machine.machineKind()).toBe('personal')
    expect(registrationModule.readStoredCloudMachine()).toBeNull()
  })

  test('an organization code is refused on a server that is registered already, before its ticket is sent', async () => {
    // WHY: the ticket has one use, and the person's sessions on this server must not become an organization's.
    let asked = 0
    const plane = controlPlane({ enroll: () => enrolled() })
    const instance = registrar(plane.fetchImpl, async () => { asked++; return false })
    await instance.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const before = plane.calls.length
    await expect(instance.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY })).rejects.toMatchObject({ code: 'register-rejected', message: expect.stringMatching(/registered already.*new data directory/) })
    expect(plane.calls).toHaveLength(before)
    expect(enrollCalls(plane)).toHaveLength(1)
    expect(instance.current()).toEqual(enrolled().registration)
    expect(machine.machineKind()).toBe('personal')
    // A personal code never asks what the server holds.
    expect(asked).toBe(0)
  })

  test('the server of the desktop app takes no organization code, before any request; it takes a personal code', async () => {
    // WHY: the desktop app's computer is a person's own always. Only a standalone server becomes a cloud machine.
    const plane = controlPlane({ enroll: () => enrolled() })
    const desktop = new registrationModule.HostRegistrar({
      installationId: () => 'install-1', hostLabel: () => 'Laptop', os: () => 'macos', owner: () => null, fetchImpl: plane.fetchImpl, isDesktopApp: () => true,
    })
    await expect(desktop.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY })).rejects.toMatchObject({ code: 'register-rejected', message: expect.stringMatching(/desktop app is a personal computer/) })
    expect(plane.calls).toEqual([])
    await desktop.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    expect(desktop.current()).toEqual(enrolled().registration)
  })

  test('an organization code is refused on a server that holds sessions, before any request', async () => {
    const plane = controlPlane({ enroll: () => enrolled('org_a') })
    const holding = registrar(plane.fetchImpl, async () => true)
    await expect(holding.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY, address: ADDRESS })).rejects.toMatchObject({ code: 'register-rejected', message: expect.stringMatching(/holds sessions already.*new data directory/) })
    // A server that cannot answer yet (its history is still being read) is refused the same way.
    const reading = registrar(plane.fetchImpl, async () => { throw new registrationModule.HostRegistrationError('register-rejected', 'This server is still reading its session history. Try again in a moment.') })
    await expect(reading.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY })).rejects.toThrow(/still reading its session history/)
    expect(plane.calls).toEqual([])
    expect(holding.current()).toBeNull()
    expect(existsSync(join(dataDir, 'host-registration.json'))).toBe(false)
    expect(machine.machineKind()).toBe('personal')
    // The same server with no sessions registers.
    const empty = registrar(plane.fetchImpl, async () => false)
    await empty.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY, address: ADDRESS })
    expect(empty.current()?.organizationId).toBe('org_a')
  })

  test.each([
    ['not_a_member', 403, /no longer a member/],
    ['machine_address_invalid', 400, /address of this machine is not valid.*https:\/\//],
    ['refused_by_host_policy', 403, /does not allow cloud machines/],
    // A Solus cloud with no tunnels cannot reach a machine that gave no address.
    ['tunnel_not_configured', 409, /has no tunnels.*`--address`/],
  ] as const)('a code the control plane refuses with %s says why and registers nothing', async (error, status, message) => {
    const plane = controlPlane({ enroll: () => Response.json({ error }, { status }) })
    const instance = registrar(plane.fetchImpl)
    await expect(instance.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY, address: ADDRESS })).rejects.toThrow(message)
    expect(instance.current()).toBeNull()
    expect(machine.machineKind()).toBe('personal')
    expect(registrationModule.readStoredCloudMachine()).toBeNull()
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
