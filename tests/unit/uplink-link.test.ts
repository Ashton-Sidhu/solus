import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPublicKey, verify } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UplinkLinkManager, registerAndLink, type UplinkConnectorHandle } from '@solus/server/transport/uplink/link'
import { HostRegistrar } from '@solus/server/host/host-registration'
import { registerUplinkHandlers } from '@solus/server/transport/handlers/uplink-handlers'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import { CLIENT_ASSERTION_TYPE, type EnrollHostResponse, type HostLinkEnv, type HostLinkResponse, type HostPublicJwk, type UplinkStatus } from '@solus/contracts/uplink'
import { linkDescription, registrationDescription } from '../../packages/workspace-ui/src/contexts/connections/host-routes'

// docs/adr/0001-standard-authentication.md §2.2 rules 8 and 9. A host's identity is its
// registration: a key it made, registered with a ticket its owner's client got. The link
// only exposes a registered host to the internet through cloudflared: turning it on or
// off touches the tunnel and nothing else. Desired state is written before anything acts
// on it, so a crash between the control plane, the connector, and the secret store
// resumes correctly at boot. A cloud machine (plans/034-one-cloud-machine-kind.md §3) is
// reached at its own address: its link has no tunnel, no connector, and no connector token.

const DIRECTORY = 'https://app.example.test'
const HOST_ID = 'abcdefghijklmnop'
/** The address an operator gives with an organization code (`solus setup --address`). */
const MACHINE_ADDRESS = 'https://vm.acme.example.test'

interface Call { method: string; url: string; body: unknown; authorization: string | null }

/** What the account plane registered for the host's client: the public half of its key, and for a cloud machine its organization and address. */
interface Registered { key: HostPublicJwk | null; generation: number; linked: boolean; organizationId?: string; address?: string }

function assertionValid(assertion: string, key: HostPublicJwk | null): boolean {
  const [header, body, signature] = assertion.split('.')
  if (!key || !header || !body || !signature) return false
  const signed = verify('sha256', Buffer.from(`${header}.${body}`), { key: createPublicKey({ key: { ...key }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  return signed && claims.iss === `host_${HOST_ID}` && claims.sub === claims.iss && claims.aud === `${DIRECTORY}/api/auth/oauth2/token`
}

function fakeControlPlane(options: { enroll?: () => Response; link?: () => Response; makeLink?: () => Response; unlink?: () => Response; credential?: () => Response; state?: Registered } = {}) {
  const calls: Call[] = []
  const state: Registered = options.state ?? { key: null, generation: 0, linked: false }
  let issued = 0
  const registrationOf = (generation: number) => ({ hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY, generation, ...(state.organizationId ? { organizationId: state.organizationId } : {}) })
  const tunnel = { hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 }
  /** A cloud machine's link: its own address, with no tunnel behind it. */
  const reach = () => ({ hostname: new URL(state.address!).host, proxiedPort: 34118 })
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
      // A ticket an organization issued comes with the machine's address, and its registration names the organization.
      if (body.address) Object.assign(state, { organizationId: 'org_acme', address: body.address })
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
      const answer: HostLinkResponse = { hostId: HOST_ID, generation: state.generation, desired: state.linked ? 'linked' : 'unlinked', tunnel: state.linked ? state.address ? reach() : tunnel : null }
      return Response.json(answer)
    }
    if (url.endsWith('/link') && method === 'POST') {
      if (options.makeLink) return options.makeLink()
      state.linked = true
      return Response.json(state.address ? { tunnel: reach() } : { tunnel, connectorToken: 'connector-token-1' })
    }
    if (url.endsWith('/link') && method === 'DELETE') {
      if (options.unlink) return options.unlink()
      state.linked = false
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }
  return { calls, fetchImpl, state, registrationOf, tunnel, reach }
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
function hostOf(plane: ReturnType<typeof fakeControlPlane>, options: { proxiedPort?: number; env?: HostLinkEnv | null; holdsWork?: () => Promise<boolean> } = {}) {
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
    holdsWork: options.holdsWork,
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

  test('a registered host redeems no organization code: the code is refused here, and Solus cloud is not asked', async () => {
    // WHY: a registered host was attached to an organization with such a code. Now the code
    // makes a cloud machine, which starts with new data, so a person's host never becomes one.
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await host.registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const asked = routeCalls(plane.calls).length
    await expect(host.registrar.register({ ticket: 'set_org', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS })).rejects.toThrow(/registered already/)
    expect(routeCalls(plane.calls)).toHaveLength(asked)
    expect(host.registrar.current()).toEqual(plane.registrationOf(1))
    expect(host.registrations).toEqual([`${HOST_ID}:1`])
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
    expect(rebooted.connector.events).toEqual(['stop'])
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

describe('linking a device to Solus cloud: a new registration links (rule 9, amended)', () => {
  useDataDir('solus-register-and-link-test-')
  const linkPosts = (plane: ReturnType<typeof fakeControlPlane>) => plane.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/link'))

  test('the first registration turns the tunnel on, so every device the owner signs in on reaches the host', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await registerAndLink(host.registrar, host.link, { ticket: 'set_ticket', directoryUrl: DIRECTORY })
    expect(host.status()).toMatchObject({ registration: { registered: true }, link: { linked: true, tunnel: plane.tunnel } })
    expect(host.connector.events).toEqual(['start'])
  })

  test('the desktop registers its own host without a link, so the Mac stays off the internet until its owner turns Link on', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await registerAndLink(host.registrar, host.link, { ticket: 'set_ticket', directoryUrl: DIRECTORY, link: false })
    expect(host.status()).toMatchObject({ registration: { registered: true }, link: { linked: false } })
    expect(host.connector.events).toEqual([])
    expect(linkPosts(plane)).toHaveLength(0)
  })

  test('a host registered already keeps the link its owner chose: an unlink stays an unlink', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await registerAndLink(host.registrar, host.link, { ticket: 'set_ticket', directoryUrl: DIRECTORY })
    await host.link.unlink()
    // A second client that also saw the host, or the desktop presenting again, registers nothing new.
    await registerAndLink(host.registrar, host.link, { ticket: 'set_again', directoryUrl: DIRECTORY })
    expect(host.status().link).toEqual({ linked: false })
    expect(linkPosts(plane)).toHaveLength(1)
  })

  test('a link that fails keeps the registration, and the link status says why', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane, { proxiedPort: 0 })
    await registerAndLink(host.registrar, host.link, { ticket: 'set_ticket', directoryUrl: DIRECTORY })
    expect(host.status().registration).toMatchObject({ registered: true })
    expect(host.status().link).toEqual({ linked: false, error: expect.stringMatching(/tunnel listener/) })
  })

  test('a refused registration makes no link', async () => {
    const plane = fakeControlPlane({ enroll: () => Response.json({ error: 'invalid_ticket' }, { status: 401 }) })
    const host = hostOf(plane)
    await expect(registerAndLink(host.registrar, host.link, { ticket: 'set_bad', directoryUrl: DIRECTORY })).rejects.toThrow(/ticket is invalid/)
    expect(linkPosts(plane)).toHaveLength(0)
  })
})

describe('a cloud machine that registered with an organization code: reached at its own address', () => {
  const dataDir = useDataDir('solus-cloud-machine-link-test-')
  const code = { ticket: 'set_org', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS }
  const tokensFile = () => join(dataDir(), 'secrets', 'uplink-tokens.json')

  test('the code registers the machine and links it at once: its address comes back, no connector runs, and it is online', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await registerAndLink(host.registrar, host.link, code)
    expect(routeCalls(plane.calls).map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /v1/hosts/enroll', `POST /v1/hosts/${HOST_ID}/link`])
    expect(routeCalls(plane.calls)[0]!.body).toMatchObject({ ticket: 'set_org', address: MACHINE_ADDRESS })
    expect(host.registrar.current()).toMatchObject({ organizationId: 'org_acme' })
    expect(host.status().link).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, state: { observed: 'online' } })
    expect(host.connector.events).toEqual([])
    // No connector token exists for it, here or in Solus cloud.
    expect(existsSync(tokensFile()) ? readFileSync(tokensFile(), 'utf8') : '').not.toContain('connectorToken')
  })

  test('at boot its stored link starts with no connector token: it is online, not an error', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    const first = hostOf(fakeControlPlane({ state }))
    await registerAndLink(first.registrar, first.link, code)
    const rebooted = hostOf(fakeControlPlane({ state }))
    await rebooted.boot()
    expect(rebooted.connector.events).toEqual([])
    expect(rebooted.status().link).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, state: { observed: 'online' } })
  })

  test('a first link that did not finish is asked for again at boot: Solus cloud holds the address', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    let cloudDown = true
    const plane = fakeControlPlane({ state, makeLink: () => {
      if (cloudDown) return Response.json({ error: 'tunnel_provisioning_failed' }, { status: 502 })
      state.linked = true
      return Response.json({ tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 } })
    } })
    const first = hostOf(plane)
    await registerAndLink(first.registrar, first.link, code)
    // The registration stays; the machine is not reachable yet, and it says why.
    expect(first.status()).toMatchObject({ registration: { registered: true }, link: { linked: false, error: expect.any(String) } })
    expect(existsSync(join(dataDir(), 'host-link.json'))).toBe(false)

    cloudDown = false
    const rebooted = hostOf(plane)
    await rebooted.boot()
    expect(routeCalls(plane.calls).at(-1)).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/link`, authorization: CONTROL_TOKEN })
    expect(rebooted.status().link).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, state: { observed: 'online' } })
    expect(rebooted.connector.events).toEqual([])
  })

  test('a link that still cannot be made at boot leaves the machine registered, with the reason in its status', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    const plane = fakeControlPlane({ state, makeLink: () => Response.json({ error: 'tunnel_provisioning_failed' }, { status: 502 }) })
    const first = hostOf(plane)
    await registerAndLink(first.registrar, first.link, code)
    const rebooted = hostOf(plane)
    await rebooted.boot()
    expect(rebooted.registrar.current()).toMatchObject({ organizationId: 'org_acme' })
    expect(rebooted.status().link).toEqual({ linked: false, error: expect.stringContaining('could not start') })
  })

  test('a personal host with no stored link asks for none at boot, and one whose connector token is gone says so', async () => {
    // WHY: only a cloud machine has a link with no token. A person's tunnel cannot run without its token, and an unlink stays an unlink.
    const state: Registered = { key: null, generation: 0, linked: false }
    const plane = fakeControlPlane({ state })
    const host = hostOf(plane)
    await host.registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const unlinked = hostOf(plane)
    await unlinked.boot()
    expect(plane.calls.some((call) => call.method === 'POST' && call.url.endsWith('/link'))).toBe(false)
    expect(unlinked.status().link).toEqual({ linked: false })

    await host.link.link()
    rmSync(tokensFile())
    const rebooted = hostOf(plane)
    await rebooted.boot()
    expect(rebooted.connector.events).toEqual([])
    expect(rebooted.status().link).toMatchObject({ linked: true, state: { observed: 'error', error: expect.stringContaining('tunnel credential is missing') } })
  })

  test('the code is refused on a host that holds sessions, and nothing is linked', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane, { holdsWork: async () => true })
    await expect(registerAndLink(host.registrar, host.link, code)).rejects.toThrow(/holds sessions already/)
    expect(plane.calls).toEqual([])
    expect(host.status()).toEqual({ registration: { registered: false }, link: { linked: false } })
  })
})

describe('the registration call a client makes (`uplinkRegister`)', () => {
  useDataDir('solus-uplink-register-call-test-')
  type Handler = (args: unknown[]) => Promise<unknown>

  function handlersOf(host: ReturnType<typeof hostOf>, onBecameCloudMachine: () => void = () => {}) {
    const handlers = new Map<string, Handler>()
    registerUplinkHandlers(
      { register: (name: string, handler: Handler) => handlers.set(name, handler) } as never,
      { registrar: host.registrar, manager: host.link, status: host.status, selfTest: async () => { throw new Error('not used') }, onBecameCloudMachine },
    )
    return handlers
  }
  const enrollBody = (plane: ReturnType<typeof fakeControlPlane>) => routeCalls(plane.calls).find((call) => call.url.endsWith('/v1/hosts/enroll'))?.body

  test('carries the machine address of an organization code, and the machine is linked at its address', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await handlersOf(host).get('uplinkRegister')!([{ ticket: ' set_org ', directoryUrl: ` ${DIRECTORY} `, address: ` ${MACHINE_ADDRESS} ` }])
    expect(enrollBody(plane)).toMatchObject({ ticket: 'set_org', address: MACHINE_ADDRESS })
    expect(host.status()).toMatchObject({ registration: { registered: true, registration: { organizationId: 'org_acme' } }, link: { linked: true, state: { observed: 'online' } } })
  })

  test('an organization code ends the owner connections of the server, because nobody owns a cloud machine', async () => {
    // WHY: the caller was admitted as the local owner before the registration. That standing must not outlive it.
    let ended = 0
    const cloud = hostOf(fakeControlPlane())
    await handlersOf(cloud, () => { ended += 1 }).get('uplinkRegister')!([{ ticket: 'set_org', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS }])
    expect(ended).toBe(1)
  })

  test('a personal code carries no address, also when a client sends an empty one', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    let ended = 0
    await handlersOf(host, () => { ended += 1 }).get('uplinkRegister')!([{ ticket: 'set_ticket', directoryUrl: DIRECTORY, address: '   ' }])
    expect(enrollBody(plane)).not.toHaveProperty('address')
    expect(host.registrar.current()).not.toHaveProperty('organizationId')
    // The owner of a personal machine keeps their connection.
    expect(ended).toBe(0)
  })

  test('no call takes an organization back from a host', () => {
    const handlers = handlersOf(hostOf(fakeControlPlane()))
    expect([...handlers.keys()].sort()).toEqual(['hostSelfTest', 'uplinkLink', 'uplinkRegister', 'uplinkStatus', 'uplinkUnlink'])
    expect(RPC_INVOKE_METHODS).not.toContain('uplinkDetachOrganization')
  })
})

describe('a provisioned cloud machine’s registration and link from the environment', () => {
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
