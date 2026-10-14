import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPublicKey, verify } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UplinkLinkManager, splitLegacyLinkRecord, type UplinkConnectorHandle } from '@solus/server/transport/uplink/link'
import { HostRegistrar } from '@solus/server/host/host-registration'
import { CLIENT_ASSERTION_TYPE, type EnrollHostResponse, type HostLinkEnv, type HostLinkResponse, type HostPublicJwk, type UplinkStatus } from '@solus/contracts/uplink'
import { linkDescription, registrationDescription } from '../../packages/workspace-ui/src/contexts/connections/host-routes'

// docs/adr/0001-standard-authentication.md §2.2 rules 8 and 9. A host's identity is its
// registration: a key it made, registered with a ticket its owner's client got. The link
// only exposes a registered host to the internet through cloudflared: turning it on or
// off touches the tunnel and nothing else. Desired state is written before anything acts
// on it, so a crash between the control plane, the connector, and the secret store
// resumes correctly at boot.

const DIRECTORY = 'https://app.example.test'
const HOST_ID = 'abcdefghijklmnop'

interface Call { method: string; url: string; body: unknown; authorization: string | null }

/** What the account plane registered for the host's client: the public half of its key. */
interface Registered { key: HostPublicJwk | null; generation: number; linked: boolean }

function assertionValid(assertion: string, key: HostPublicJwk | null): boolean {
  const [header, body, signature] = assertion.split('.')
  if (!key || !header || !body || !signature) return false
  const signed = verify('sha256', Buffer.from(`${header}.${body}`), { key: createPublicKey({ key: { ...key }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  return signed && claims.iss === `host_${HOST_ID}` && claims.sub === claims.iss && claims.aud === `${DIRECTORY}/api/auth/oauth2/token`
}

function fakeControlPlane(options: { enroll?: () => Response; link?: () => Response; unlink?: () => Response; credential?: () => Response; state?: Registered } = {}) {
  const calls: Call[] = []
  const state = options.state ?? { key: null, generation: 0, linked: false }
  let issued = 0
  const registrationOf = (generation: number) => ({ hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY, generation })
  const tunnel = { hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const raw = init?.body ? String(init.body) : null
    const body = raw === null ? null : raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
    calls.push({ method, url, body, authorization: headers.get('authorization') })
    if (url === `${DIRECTORY}/api/auth/oauth2/token`) {
      const valid = body?.grant_type === 'client_credentials' && body.client_assertion_type === CLIENT_ASSERTION_TYPE && assertionValid(body.client_assertion, state.key)
      return valid ? Response.json({ access_token: `control-${++issued}`, expires_in: 300 }) : Response.json({ error: 'invalid_client' }, { status: 401 })
    }
    if (url.endsWith('/v1/hosts/enroll')) {
      if (options.enroll) return options.enroll()
      state.key = body.publicJwk
      state.generation += 1
      const enrolled: EnrollHostResponse = { registration: registrationOf(state.generation), oauthClient: { clientId: `host_${HOST_ID}` } }
      return Response.json(enrolled)
    }
    if (url.endsWith('/credential') && method === 'POST') {
      if (options.credential) return options.credential()
      state.key = body.publicJwk
      return Response.json({ oauthClient: { clientId: `host_${HOST_ID}` } })
    }
    if (url.endsWith('/link') && method === 'GET') {
      if (options.link) return options.link()
      const answer: HostLinkResponse = { hostId: HOST_ID, generation: state.generation, desired: state.linked ? 'linked' : 'unlinked', tunnel: state.linked ? tunnel : null }
      return Response.json(answer)
    }
    if (url.endsWith('/link') && method === 'POST') {
      state.linked = true
      return Response.json({ tunnel, connectorToken: 'connector-token-1' })
    }
    if (url.endsWith('/link') && method === 'DELETE') {
      if (options.unlink) return options.unlink()
      state.linked = false
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }
  return { calls, fetchImpl, state, registrationOf, tunnel }
}

const routeCalls = (calls: Call[]) => calls.filter((call) => !call.url.endsWith('/oauth2/token'))
const CONTROL_TOKEN = expect.stringMatching(/^Bearer control-\d+$/)

function fakeConnector() {
  const events: string[] = []
  const handle: UplinkConnectorHandle & { events: string[]; token: string | null } = {
    events,
    token: null,
    start(token) { events.push('start'); this.token = token },
    async stop() { events.push('stop'); this.token = null },
  }
  return handle
}

/** A host as the boot composes it: the registration, and the link that follows it. */
function hostOf(plane: ReturnType<typeof fakeControlPlane>, options: { proxiedPort?: number; env?: HostLinkEnv | null } = {}) {
  const connector = fakeConnector()
  const registrations: Array<string | null> = []
  let link: UplinkLinkManager | null = null
  const registrar = new HostRegistrar({
    installationId: () => 'install-1',
    hostLabel: () => 'Ashton’s MacBook',
    os: () => 'macos',
    owner: () => ({ userId: 'user_ashton', email: 'ashton@example.test' }),
    fetchImpl: plane.fetchImpl,
    provisionedLink: () => options.env ?? null,
    onRegistrationChanged: (registration) => {
      registrations.push(registration ? `${registration.hostId}:${registration.generation}` : null)
      link?.registrationChanged(registration)
    },
  })
  link = new UplinkLinkManager({
    registration: () => registrar.current(),
    controlToken: () => registrar.controlToken(),
    proxiedPort: () => options.proxiedPort ?? 34118,
    connector,
    fetchImpl: plane.fetchImpl,
    provisionedLink: () => options.env ?? null,
  })
  const status = (): UplinkStatus => ({ registration: registrar.status(), link: link!.status() })
  const boot = async () => { await link!.resume(await registrar.resume()) }
  return { registrar, link, connector, registrations, status, boot }
}

function useDataDir(prefix: string): () => string {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir = ''
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), prefix))
    process.env.SOLUS_DATA_DIR = dataDir
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })
  return () => dataDir
}

describe('registration: the host’s identity (rule 8)', () => {
  const dataDir = useDataDir('solus-host-registration-test-')

  test('a ticket registers the host with the public half of a new key, and makes no tunnel', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    expect(host.registrar.needsRegistration()).toBe(true)

    await host.registrar.register({ ticket: 'set_ticket', directoryUrl: `${DIRECTORY}/` })
    expect(plane.calls[0]).toMatchObject({
      method: 'POST', url: `${DIRECTORY}/v1/hosts/enroll`,
      body: { ticket: 'set_ticket', installationId: 'install-1', label: 'Ashton’s MacBook', os: 'macos', publicJwk: { kty: 'EC', crv: 'P-256' } },
    })
    const sent = plane.calls[0]!.body as { publicJwk: Record<string, string> }
    expect(sent).not.toHaveProperty('proxiedPort')
    expect(sent.publicJwk).not.toHaveProperty('d')
    const kept = JSON.parse(readFileSync(join(dataDir(), 'secrets', 'host-credential.json'), 'utf8'))
    expect(kept).toMatchObject({ version: 1, clientId: `host_${HOST_ID}`, generation: 1, privateJwk: { x: sent.publicJwk.x, d: expect.any(String) } })
    expect(readFileSync(join(dataDir(), 'host-registration.json'), 'utf8')).not.toContain('"d"')
    expect(host.registrations).toEqual([`${HOST_ID}:1`])
    expect(host.registrar.needsRegistration()).toBe(false)
    // Registered, and not linked: no tunnel was asked for, and no connector runs.
    expect(host.status()).toEqual({
      registration: { registered: true, registration: plane.registrationOf(1), owner: { userId: 'user_ashton', email: 'ashton@example.test' } },
      link: { linked: false },
    })
    expect(routeCalls(plane.calls).map((call) => call.url)).toEqual([`${DIRECTORY}/v1/hosts/enroll`])
    expect(host.connector.events).toEqual([])
    expect(existsSync(join(dataDir(), 'host-link.json'))).toBe(false)
    // Its key proves it: its control token comes with an assertion that key signed.
    expect(await host.registrar.controlToken()).toBe('control-1')
  })

  test('two clients that both saw the host unregistered register it once', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await Promise.all([
      host.registrar.register({ ticket: 'set_desktop', directoryUrl: DIRECTORY }),
      host.registrar.register({ ticket: 'set_phone', directoryUrl: DIRECTORY }),
    ])
    expect(plane.calls.filter((call) => call.url.endsWith('/v1/hosts/enroll'))).toHaveLength(1)
  })

  test('a ticket that names organizations attaches a registered host, with its control token', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await host.registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    await expect(host.registrar.register({ ticket: 'set_org', directoryUrl: DIRECTORY, organizationIds: ['org_a'] })).rejects.toThrow(/refused to attach/)
    expect(routeCalls(plane.calls).at(-1)).toMatchObject({ url: `${DIRECTORY}/v1/hosts/${HOST_ID}/organizations/attach`, authorization: CONTROL_TOKEN })
  })

  test('a refused registration says why and leaves nothing behind', async () => {
    const plane = fakeControlPlane({ enroll: () => Response.json({ error: 'invalid_ticket' }, { status: 401 }) })
    const host = hostOf(plane)
    await expect(host.registrar.register({ ticket: 'set_bad', directoryUrl: DIRECTORY })).rejects.toThrow(/ticket is invalid/)
    expect(host.status().registration).toEqual({ registered: false })
    expect(existsSync(join(dataDir(), 'host-registration.json'))).toBe(false)
  })

  test('an insecure control-plane address is refused at registration', async () => {
    const plane = fakeControlPlane({
      enroll: () => Response.json({ registration: { hostId: HOST_ID, issuer: 'http://evil.example.test', jwksUrl: 'http://evil.example.test/jwks', directoryUrl: DIRECTORY, generation: 1 }, oauthClient: { clientId: `host_${HOST_ID}` } }),
    })
    const host = hostOf(plane)
    await expect(host.registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })).rejects.toThrow(/insecure address/)
    expect(host.registrar.current()).toBeNull()
  })

  test('registering the same machine again keeps its host id and rotates its key: the old key proves nothing', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    const first = hostOf(fakeControlPlane({ state }))
    await first.registrar.register({ ticket: 'set_one', directoryUrl: DIRECTORY })
    const firstKey = state.key
    // Its key went missing here: the host still knows who it is, and asks to register again.
    rmSync(join(dataDir(), 'secrets', 'host-credential.json'))
    const again = hostOf(fakeControlPlane({ state }))
    expect(again.registrar.current()?.hostId).toBe(HOST_ID)
    expect(again.registrar.needsRegistration()).toBe(true)
    await again.registrar.register({ ticket: 'set_two', directoryUrl: DIRECTORY })
    expect(again.registrar.current()).toMatchObject({ hostId: HOST_ID, generation: 2 })
    expect(state.key?.x).not.toBe(firstKey?.x)
    expect(again.registrar.needsRegistration()).toBe(false)
  })

  test('a registration Solus cloud no longer accepts is forgotten at boot: the host is not registered', async () => {
    // WHY: a deleted host is personal again, and an unregistered host follows the one rule (`needsRegistration`).
    const state: Registered = { key: null, generation: 0, linked: false }
    await hostOf(fakeControlPlane({ state })).registrar.register({ ticket: 'set_one', directoryUrl: DIRECTORY })
    state.key = null
    const rebooted = hostOf(fakeControlPlane({ state }))
    await rebooted.boot()
    expect(rebooted.registrar.current()).toBeNull()
    expect(rebooted.registrations).toEqual([null])
    expect(rebooted.status().registration).toEqual({ registered: false })
    expect(rebooted.registrar.needsRegistration()).toBe(true)
  })

  test('a refusal while the host runs forgets the registration the same way, and a new registration works', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await host.registrar.register({ ticket: 'set_one', directoryUrl: DIRECTORY })
    plane.state.key = null
    await expect(host.registrar.controlToken()).rejects.toThrow()
    expect(host.registrar.current()).toBeNull()
    expect(host.status().registration).toEqual({ registered: false })
    expect(host.registrar.needsRegistration()).toBe(true)
    await host.registrar.register({ ticket: 'set_again', directoryUrl: DIRECTORY })
    expect(host.registrar.current()).toMatchObject({ generation: 2 })
  })

  test('a host that stored one record for its registration and its link keeps both', async () => {
    writeFileSync(join(dataDir(), 'uplink-link.json'), JSON.stringify({
      version: 1,
      desired: 'linked',
      link: { hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY, hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118, connectionGeneration: 3 },
      attachedAt: 1,
    }))
    splitLegacyLinkRecord()
    const host = hostOf(fakeControlPlane())
    expect(host.registrar.current()).toEqual({ hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY, generation: 3 })
    expect(host.registrar.attachedAt()).toBe(1)
    expect(host.link.currentTunnel()).toEqual({ hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 })
    expect(existsSync(join(dataDir(), 'uplink-link.json'))).toBe(false)
  })
})

describe('the link: a tunnel, and nothing else (rule 9)', () => {
  const dataDir = useDataDir('solus-uplink-link-test-')

  async function registered(plane = fakeControlPlane(), options: Parameters<typeof hostOf>[1] = {}) {
    const host = hostOf(plane, options)
    await host.registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    return host
  }

  /** Everything the registration owns, to compare before and after a link change. */
  const identityOf = (host: ReturnType<typeof hostOf>) => ({
    registration: host.registrar.current(),
    key: readFileSync(join(dataDir(), 'secrets', 'host-credential.json'), 'utf8'),
    record: readFileSync(join(dataDir(), 'host-registration.json'), 'utf8'),
  })

  test('a host that is not registered cannot link', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await expect(host.link.link()).rejects.toThrow(/Sign in/)
    expect(plane.calls).toHaveLength(0)
  })

  test('linking asks Solus cloud for the tunnel with the control token, keeps its secret out of the record, and starts the connector; the registration does not change', async () => {
    const plane = fakeControlPlane()
    const host = await registered(plane)
    const before = identityOf(host)

    const status = await host.link.link()
    expect(status).toEqual({ linked: true, tunnel: plane.tunnel, state: { observed: 'offline' } })
    expect(routeCalls(plane.calls).at(-1)).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/link`, authorization: CONTROL_TOKEN, body: { proxiedPort: 34118 } })
    expect(host.connector.events).toEqual(['start'])
    expect(host.connector.token).toBe('connector-token-1')
    const record = readFileSync(join(dataDir(), 'host-link.json'), 'utf8')
    expect(record).toContain('"desired": "linked"')
    expect(record).not.toContain('connector-token-1')
    expect(identityOf(host)).toEqual(before)
    expect(host.registrations).toEqual([`${HOST_ID}:1`])
  })

  test('unlinking stops the connector and removes only the tunnel: the key, the registration, and the control token stay', async () => {
    const plane = fakeControlPlane()
    const host = await registered(plane)
    await host.link.link()
    const before = identityOf(host)

    expect(await host.link.unlink()).toEqual({ linked: false })
    expect(host.connector.events).toEqual(['start', 'stop'])
    expect(plane.calls.find((call) => call.method === 'DELETE')).toMatchObject({ url: `${DIRECTORY}/v1/hosts/${HOST_ID}/link`, authorization: CONTROL_TOKEN })
    expect(existsSync(join(dataDir(), 'host-link.json'))).toBe(false)
    expect(existsSync(join(dataDir(), 'secrets', 'uplink-tokens.json'))).toBe(false)
    expect(identityOf(host)).toEqual(before)
    expect(host.registrations).toEqual([`${HOST_ID}:1`])
    expect(host.status().registration).toMatchObject({ registered: true })
    // The host still proves itself, so it can link again with no new registration.
    expect(await host.registrar.controlToken()).toMatch(/^control-/)
    await host.link.link()
    expect(plane.calls.filter((call) => call.url.endsWith('/v1/hosts/enroll'))).toHaveLength(1)
  })

  test('without a tunnel listener nothing is linked', async () => {
    const plane = fakeControlPlane()
    const host = await registered(plane, { proxiedPort: 0 })
    await expect(host.link.link()).rejects.toThrow(/tunnel listener/)
    expect(plane.calls.some((call) => call.method === 'POST' && call.url.endsWith('/link'))).toBe(false)
  })

  test('an unlink the control plane never saw is finished at the next boot', async () => {
    let planeDown = true
    const state: Registered = { key: null, generation: 0, linked: false }
    const plane = fakeControlPlane({ state, unlink: () => { if (planeDown) throw new Error('ECONNREFUSED'); state.linked = false; return new Response(null, { status: 204 }) } })
    const host = await registered(plane)
    await host.link.link()
    await host.link.unlink()
    expect(JSON.parse(readFileSync(join(dataDir(), 'host-link.json'), 'utf8')).desired).toBe('unlinked')

    planeDown = false
    const rebooted = hostOf(plane)
    await rebooted.boot()
    expect(existsSync(join(dataDir(), 'host-link.json'))).toBe(false)
    expect(rebooted.connector.events).toEqual([])
    expect(rebooted.registrar.current()).toMatchObject({ hostId: HOST_ID })
  })

  test('at boot a registered, linked host checks its registration, then runs the connector', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    const host = await registered(fakeControlPlane({ state }))
    await host.link.link()
    const rebooted = hostOf(fakeControlPlane({ state }))
    await rebooted.boot()
    expect(rebooted.connector.events).toEqual(['start'])
    expect(rebooted.status().link).toMatchObject({ linked: true })
  })

  test('a link Solus cloud ended elsewhere stops here at boot, and the registration stays', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    const host = await registered(fakeControlPlane({ state }))
    await host.link.link()
    state.linked = false
    const rebooted = hostOf(fakeControlPlane({ state }))
    await rebooted.boot()
    expect(rebooted.connector.events).toEqual([])
    expect(rebooted.status()).toMatchObject({ registration: { registered: true }, link: { linked: false } })
  })

  test('a host whose registration ends drops its tunnel with it', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    const host = await registered(fakeControlPlane({ state }))
    await host.link.link()
    // The owner deleted the host: its key proves nothing, and its tunnel serves nobody.
    state.key = null
    const rebooted = hostOf(fakeControlPlane({ state }))
    await rebooted.boot()
    expect(rebooted.registrar.current()).toBeNull()
    expect(rebooted.connector.events).toEqual(['stop'])
    expect(rebooted.status().link).toEqual({ linked: false })
    expect(existsSync(join(dataDir(), 'host-link.json'))).toBe(false)
  })

  test('a linked host whose port another process took says so instead of running a dead tunnel', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    const host = await registered(fakeControlPlane({ state }))
    await host.link.link()
    const rebooted = hostOf(fakeControlPlane({ state }), { proxiedPort: 40000 })
    await rebooted.boot()
    expect(rebooted.connector.events).toEqual([])
    expect(rebooted.status().link).toMatchObject({ linked: true, state: { observed: 'error', error: expect.stringContaining('Port 34118 is in use') } })
  })

  test('what the connector observes is the link’s status line, and the registration line says whose host it is', async () => {
    const host = await registered()
    expect(registrationDescription(host.status())).toBe('Registered to ashton@example.test. Your devices reach it on your local network or by pairing.')
    expect(linkDescription(host.status())).toMatch(/Cloudflare tunnel\. Nothing else changes\./)
    await host.link.link()
    host.link.handleConnectorObservation({ observed: 'online' })
    expect(linkDescription(host.status())).toBe(`Reachable at h-${HOST_ID}.example.test through a Cloudflare tunnel.`)
  })
})

describe('a managed host’s registration and link from the environment', () => {
  useDataDir('solus-managed-link-test-')

  const envOf = (plane: ReturnType<typeof fakeControlPlane>, generation = 1): HostLinkEnv => ({
    registration: { ...plane.registrationOf(generation), organizationId: 'org_acme' },
    tunnel: { hostname: 'acme.sprites.test', proxiedPort: 34118 },
    credentialTicket: `hct_ticket-${generation}`,
  })

  test('the first boot makes a key, registers its public half with the ticket, and is reached directly: no connector', async () => {
    const plane = fakeControlPlane({ state: { key: null, generation: 1, linked: true } })
    const host = hostOf(plane, { env: envOf(plane) })
    await host.boot()
    expect(routeCalls(plane.calls)[0]).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/credential`, authorization: null, body: { credentialTicket: 'hct_ticket-1', publicJwk: { kty: 'EC', crv: 'P-256' } } })
    expect(host.connector.events).toEqual([])
    expect(host.registrar.current()).toMatchObject({ organizationId: 'org_acme', generation: 1 })
    expect(host.status().link).toEqual({ linked: true, tunnel: { hostname: 'acme.sprites.test', proxiedPort: 34118 }, state: { observed: 'online' } })
  })

  test('an environment with a newer generation replaces the registration with a new key: a recreated machine adopts it', async () => {
    const plane = fakeControlPlane({ state: { key: null, generation: 1, linked: true } })
    await hostOf(plane, { env: envOf(plane, 1) }).boot()
    const firstKey = plane.state.key
    plane.state.generation = 2
    const recreated = hostOf(plane, { env: envOf(plane, 2) })
    await recreated.boot()
    expect(recreated.registrar.current()).toMatchObject({ generation: 2 })
    expect(plane.state.key?.x).not.toBe(firstKey?.x)
  })

  test('a refused ticket registers nothing', async () => {
    const plane = fakeControlPlane({ credential: () => Response.json({ error: 'invalid_ticket' }, { status: 401 }) })
    const host = hostOf(plane, { env: envOf(plane) })
    await host.boot()
    expect(host.registrar.current()).toBeNull()
    expect(host.status().link).toEqual({ linked: false })
  })

  test('a personal host with nothing in its environment and nothing stored does nothing at boot', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await host.boot()
    expect(plane.calls).toHaveLength(0)
    expect(host.status()).toEqual({ registration: { registered: false }, link: { linked: false } })
  })
})
