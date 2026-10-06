import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT_TYPE, type EnrollHostResponse, type UplinkLinkConfig } from '@solus/contracts/uplink'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/009-organization-vms.md §4, §5: a self-hosted server's organization
// attachment is persisted with its link before organization work is admitted, a
// person's own computer is never attached, and an unlink resets the server to
// personal. A linked server redeems an organization code as an attachment, from
// the account plane it is linked to only.
//
// plans/010-standard-oauth.md: the host acts for a person with its own OAuth client
// — one token exchange with the token their client presented, then refreshes, each
// the account plane's live check; nothing per prompt. A refused refresh ends the
// person's work here. The Solus API the link named is the only one it sends to.

const DIRECTORY = 'https://app.example.test'
const API = 'https://api.example.test'
const HOST_ID = 'abcdefghijklmnop'

interface Call { method: string; url: string; body: unknown; authorization: string | null }

function recordingFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    const raw = input instanceof Request ? await input.text() : init?.body ? String(init.body) : ''
    const call = { method: (input instanceof Request ? input.method : init?.method) ?? 'GET', url, body: raw ? JSON.parse(raw) : null, authorization: headers.get('authorization') }
    calls.push(call)
    return answer(call)
  }
  return { calls, fetchImpl }
}

const enrolled = (organizationIds?: string[]): EnrollHostResponse => ({
  link: { hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY, hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118, connectionGeneration: 1, apiUrl: API },
  connectorToken: 'connector-token-1',
  hostToken: 'sht_host-token-1',
  oauthClient: { clientId: `host_${HOST_ID}`, clientSecret: 'shc_client-secret-1' },
  ...(organizationIds ? { organizationIds } : {}),
})

describe('the organization attachment of a linked server', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  let link: typeof import('@solus/server/transport/uplink/link')
  let hostCategory: typeof import('@solus/server/host/host-category')

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-host-authentication-'))
    process.env.SOLUS_DATA_DIR = dataDir
    link = await import('@solus/server/transport/uplink/link')
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

  function manager(fetchImpl: ReturnType<typeof recordingFetch>['fetchImpl']) {
    return new link.UplinkLinkManager({
      installationId: () => 'install-1', hostLabel: () => 'Lab VM', os: () => 'linux', proxiedPort: () => 34118,
      connector: { start() {}, async stop() {} }, fetchImpl,
    })
  }

  const controlPlane = (options: { enroll?: () => EnrollHostResponse; attach?: () => Response } = {}) => recordingFetch((call) => {
    if (call.url.endsWith('/v1/hosts/enroll')) return Response.json(options.enroll?.() ?? enrolled())
    if (call.url.endsWith('/organizations/attach')) return options.attach?.() ?? Response.json({ organizationIds: ['org_a'] })
    if (call.method === 'DELETE' && call.url.includes('/organizations/')) return new Response(null, { status: 204 })
    if (call.url.endsWith('/link') && call.method === 'GET') return Response.json({ hostId: HOST_ID, desired: 'linked', connectionGeneration: 1, hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 })
    if (call.url.endsWith('/link') && call.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('not found', { status: 404 })
  })

  test('an enrollment that attached organizations is persisted as attached with the link; a restart keeps it; an unlink resets the server to personal', async () => {
    let answer = enrolled(['org_a'])
    const plane = controlPlane({ enroll: () => answer })
    const first = manager(plane.fetchImpl)
    await first.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const attachedAt = first.attachedAt()
    expect(attachedAt).toBeNumber()
    expect(JSON.parse(readFileSync(join(dataDir, 'uplink-link.json'), 'utf8'))).toMatchObject({ desired: 'linked', attachedAt, link: { apiUrl: API } })
    // A restarted process reads the same boundary, before it admits anything.
    expect(manager(plane.fetchImpl).attachedAt()).toBe(attachedAt)
    expect(link.readStoredLink()?.apiUrl).toBe(API)
    await first.unlink()
    expect(first.attachedAt()).toBeNull()
    expect(existsSync(join(dataDir, 'uplink-link.json'))).toBe(false)
    // Linking again with a personal code leaves it personal.
    answer = enrolled()
    await first.link({ ticket: 'set_again', directoryUrl: DIRECTORY })
    expect(first.attachedAt()).toBeNull()
  })

  test('a person\'s own computer is never attached, whatever its link says', async () => {
    hostCategory.applyHostCategory('personal')
    const instance = manager(controlPlane({ enroll: () => enrolled(['org_a']) }).fetchImpl)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    expect(instance.attachedAt()).toBeNull()
    expect(instance.markAttached()).toBeNull()
  })

  test('a linked server redeems an organization code as an attachment, only from its own account plane; a removed organization leaves the attachment in place', async () => {
    const plane = controlPlane()
    const instance = manager(plane.fetchImpl)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    expect(instance.attachedAt()).toBeNull()

    // A code from another account plane is refused before anything is sent there.
    await expect(instance.link({ ticket: 'set_elsewhere', directoryUrl: 'https://other.example.test' })).rejects.toThrow(/linked to https:\/\/app.example.test/)
    expect(plane.calls.some((call) => call.url.startsWith('https://other.example.test'))).toBe(false)

    await instance.link({ ticket: 'set_org', directoryUrl: DIRECTORY })
    const attach = plane.calls.find((call) => call.url.endsWith('/organizations/attach'))
    expect(attach).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/organizations/attach`, body: { ticket: 'set_org' }, authorization: 'Bearer sht_host-token-1' })
    expect(instance.attachedAt()).toBeNumber()

    // Taking one organization back does not make the server personal again (no automatic fallback).
    await instance.detach('org_a')
    expect(plane.calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/organizations/org_a`, authorization: 'Bearer sht_host-token-1' })
    expect(instance.attachedAt()).toBeNumber()
  })

  test('a refused attachment says why and changes nothing', async () => {
    const plane = controlPlane({ attach: () => Response.json({ error: 'not_a_member' }, { status: 403 }) })
    const instance = manager(plane.fetchImpl)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    await expect(instance.link({ ticket: 'set_org', directoryUrl: DIRECTORY })).rejects.toThrow(/no longer a member/)
    expect(instance.attachedAt()).toBeNull()
  })

  test('an enrollment that names an insecure Solus API is not stored', async () => {
    const insecure = enrolled()
    insecure.link.apiUrl = 'http://api.example.test'
    const instance = manager(controlPlane({ enroll: () => insecure }).fetchImpl)
    await expect(instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })).rejects.toThrow(/insecure address/)
    expect(existsSync(join(dataDir, 'uplink-link.json'))).toBe(false)
  })
})

describe('the host acting for a person', () => {
  const LINK: UplinkLinkConfig = enrolled().link
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

  /** The account plane's token endpoint and the Solus API. Every request is recorded; form bodies are read as forms. */
  function cloud(options: { token?: (form: URLSearchParams) => Response | Promise<Response>; admit?: () => Response } = {}) {
    let issued = 0
    const calls: Array<{ url: string; authorization: string | null; form: URLSearchParams | null; body: unknown }> = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      const form = init?.body instanceof URLSearchParams ? init.body : null
      calls.push({ url, authorization: headers.get('authorization'), form, body: form ? null : init?.body ? JSON.parse(String(init.body)) : null })
      if (url === TOKEN_URL) {
        if (options.token) return options.token(form!)
        issued += 1
        return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 300, token_type: 'Bearer' })
      }
      if (url === `${API}/v1/auth/session`) {
        return Response.json({ accessToken: 'api-credential', tokenType: 'Bearer', expiresAt: new Date(Date.now() + 300_000).toISOString(), scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read', 'sessions:admit'], home: { kind: 'organization', serviceId: 'solus-api', organizationId: 'org_a' }, subject: { kind: 'user', userId: 'bob', displayName: 'Bob', sessionId: null } })
      }
      if (url === `${API}/v1/session-admissions`) return options.admit?.() ?? Response.json({ sessionId: 'solus-1', organizationId: 'org_a', ownerUserId: 'bob', hostId: HOST_ID, admittedAt: new Date(0).toISOString() }, { status: 201 })
      return new Response('not found', { status: 404 })
    }
    return { calls, fetchImpl }
  }

  function delegations(fetchImpl: ReturnType<typeof cloud>['fetchImpl'], options: { tokens?: Record<string, string>; now?: () => number; revoked?: Array<[string, string]> } = {}) {
    const tokens = options.tokens ?? { bob: 'bob-token-for-this-host' }
    return new delegationsModule.Delegations({
      link: () => LINK,
      client: () => ({ clientId: `host_${HOST_ID}`, clientSecret: 'shc_client-secret-1' }),
      personToken: (userId) => tokens[userId] ?? null,
      onRevoked: (userId, organizationId) => { options.revoked?.push([userId, organizationId]) },
      fetchImpl,
      now: options.now,
    })
  }

  test('the first organization turn trades the person\'s token for the host\'s own, and the API admits the session; later turns ask nobody', async () => {
    // WHY: nothing is asked of the account plane per prompt (plans/010-standard-oauth.md §1).
    const plane = cloud()
    const held = delegations(plane.fetchImpl)
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: true })
    expect(plane.calls.map((call) => call.url)).toEqual([TOKEN_URL, `${API}/v1/auth/session`, `${API}/v1/session-admissions`])
    const exchange = plane.calls[0]!
    expect(exchange.authorization).toBe(`Basic ${Buffer.from(`host_${HOST_ID}:shc_client-secret-1`).toString('base64')}`)
    expect(Object.fromEntries(exchange.form!)).toEqual({ grant_type: TOKEN_EXCHANGE_GRANT_TYPE, subject_token: 'bob-token-for-this-host', subject_token_type: ACCESS_TOKEN_TYPE, organization_id: 'org_a' })
    // The API credential is the delegated access token exchanged, never the host token.
    expect(plane.calls[1]!.authorization).toBe('Bearer access-1')
    expect(plane.calls[2]!.body).toEqual({ sessionId: 'solus-1' })
    // The next turns of the session, and its answers, reach nobody while the token is good.
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: false })
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: false })
    expect(plane.calls).toHaveLength(3)
    // Its tools find who they act for by the session id.
    expect(held.actorOf('solus-1')).toEqual({ userId: 'bob', organizationId: 'org_a' })
  })

  test('a person with no token here cannot start organization work, and nothing is sent', async () => {
    const plane = cloud()
    await expect(delegations(plane.fetchImpl, { tokens: {} }).actFor({ sessionId: 'solus-2', userId: 'mallory', organizationId: 'org_a', admit: true })).rejects.toMatchObject({ code: 'ORGANIZATION_AUTHORITY_MISSING' })
    expect(plane.calls).toEqual([])
  })

  test('a token about to run out is refreshed, as the host, and the rotated refresh token survives a restart', async () => {
    // WHY: runs and automations continue after every client closed and after the host restarts.
    let now = 1_000_000
    const plane = cloud()
    const held = delegations(plane.fetchImpl, { now: () => now })
    await held.ensure('bob', 'org_a')
    now += 290_000
    expect(await held.accessToken('bob', 'org_a')).toBe('access-2')
    expect(Object.fromEntries(plane.calls[1]!.form!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1' })
    // A new process, and nobody connected: the stored refresh token is enough.
    const restarted = delegations(plane.fetchImpl, { tokens: {}, now: () => now })
    expect(restarted.has('bob', 'org_a')).toBe(true)
    expect(await restarted.accessToken('bob', 'org_a')).toBe('access-3')
    expect(Object.fromEntries(plane.calls[2]!.form!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-2' })
  })

  test('a refused refresh ends the person\'s work here; an outage keeps a continuation going, never a new session', async () => {
    let now = 1_000_000
    let mode: 'ok' | 'down' | 'refused' = 'ok'
    const plane = cloud({ token: (form) => {
      if (mode === 'down') throw new TypeError('fetch failed')
      if (mode === 'refused') return Response.json({ error: 'invalid_grant', error_description: 'The person is not a member of the organization.' }, { status: 400 })
      return Response.json({ access_token: `access-${form.get('grant_type')}`, refresh_token: 'refresh-x', expires_in: 300 })
    } })
    const revoked: Array<[string, string]> = []
    const held = delegations(plane.fetchImpl, { now: () => now, revoked })
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: false })
    now += 400_000
    mode = 'down'
    await held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: false })
    await expect(held.actFor({ sessionId: 'solus-new', userId: 'bob', organizationId: 'org_a', admit: true })).rejects.toMatchObject({ code: 'ORGANIZATION_API_UNAVAILABLE' })
    expect(revoked).toEqual([])
    mode = 'refused'
    await expect(held.accessToken('bob', 'org_a')).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_REFUSED', message: expect.stringContaining('not a member') })
    expect(revoked).toEqual([['bob', 'org_a']])
    expect(held.has('bob', 'org_a')).toBe(false)
    expect(held.actorOf('solus-1')).toBeNull()
  })

  test('an API that refuses the admission prevents the start', async () => {
    const plane = cloud({ admit: () => Response.json({ error: { code: 'CONFLICT', message: 'This session was admitted for another person or host.', requestId: 'r1' } }, { status: 409 }) })
    const held = delegations(plane.fetchImpl)
    await expect(held.actFor({ sessionId: 'solus-1', userId: 'bob', organizationId: 'org_a', admit: true })).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_REFUSED' })
    expect(held.actorOf('solus-1')).toBeNull()
  })
})

describe('the Solus API a host delivers to is the one its link named', () => {
  test('rows travel with their person\'s delegated token to the link\'s API and nowhere else', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-host-authentication-delivery-'))
    const previousDataDir = process.env.SOLUS_DATA_DIR
    process.env.SOLUS_DATA_DIR = dataDir
    const delivery = await import('@solus/server/sync/runner-delivery')
    const outbox = await import('@solus/server/sync/outbox/outbox-store')
    const dbModule = await import('@solus/server/db')
    try {
      const plane = recordingFetch(() => Response.json({ lastSeq: 1, failed: [] }))
      outbox.recordOutboxOp({ domain: 'tasks', resourceId: 'task-1', name: 'comment', payload: { body: 'x' }, destination: 'cloud', organizationId: 'org_a', actorUserId: 'bob' })
      const runner = new delivery.RunnerDelivery({
        link: () => enrolled().link,
        delegations: { ensure: async () => {}, accessToken: async (userId, organizationId) => `delegated-${userId}-${organizationId}`, holders: () => [] },
        linker: () => 'alice',
        fetchImpl: plane.fetchImpl,
        setTimeoutFn: ((fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 10))) as typeof setTimeout,
      })
      runner.start()
      for (let attempt = 0; attempt < 100 && outbox.cloudOutboxDestinations().length > 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
      await runner.stop()
      expect(plane.calls.map((call) => [new URL(call.url).origin, call.authorization])).toEqual([[API, 'Bearer delegated-bob-org_a']])
      expect(outbox.cloudOutboxDestinations()).toEqual([])
    } finally {
      dbModule.closeDb()
      rmSync(dataDir, { recursive: true, force: true })
      if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
      else process.env.SOLUS_DATA_DIR = previousDataDir
    }
  })
})
