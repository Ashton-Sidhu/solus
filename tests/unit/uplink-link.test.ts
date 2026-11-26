import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPublicKey, verify } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UplinkLinkManager, registerAndLink, type UplinkConnectorHandle } from '@solus/server/transport/uplink/link'
import { HostRegistrar, enrollAtBoot, readStoredCloudMachine, readStoredRegistration } from '@solus/server/host/host-registration'
import { registerUplinkHandlers } from '@solus/server/transport/handlers/uplink-handlers'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import { CLIENT_ASSERTION_TYPE, isOrganizationTicket, type EnrollHostResponse, type HostLinkResponse, type HostPublicJwk, type UplinkStatus } from '@solus/contracts/uplink'
import { linkDescription, registrationDescription } from '../../packages/workspace-ui/src/contexts/connections/host-routes'

// docs/adr/0001-standard-authentication.md §2.2 rules 8 and 9. A host's identity is its
// registration: a key it made, registered with a ticket its owner's client got. The link
// only exposes a registered host to the internet: turning it on or off touches the reach
// and nothing else. Desired state is written before anything acts on it, so a crash
// between the control plane, the connector, and the secret store resumes correctly at boot.
//
// plans/034-one-cloud-machine-kind.md §3: every machine joins the same way. The code
// decides what the machine is: a personal code (`set_…`) makes a personal host, an
// organization code (`org_…`) makes a cloud machine. The address decides how the
// internet reaches it, for both kinds: with an address the link has no tunnel, no
// connector, and no connector token; without one the host gets a Cloudflare tunnel.

const DIRECTORY = 'https://app.example.test'
const HOST_ID = 'abcdefghijklmnop'
/** The address an operator gives with a code (`solus setup --address`), or sets later (`solus connect --address`). */
const MACHINE_ADDRESS = 'https://vm.acme.example.test'

interface Call { method: string; url: string; body: unknown; authorization: string | null }

/** What the account plane registered for the host's client: the public half of its key, its organization when its ticket was an organization's, and its address when it gave one. */
interface Registered { key: HostPublicJwk | null; generation: number; linked: boolean; organizationId?: string; address?: string }

function assertionValid(assertion: string, key: HostPublicJwk | null): boolean {
  const [header, body, signature] = assertion.split('.')
  if (!key || !header || !body || !signature) return false
  const signed = verify('sha256', Buffer.from(`${header}.${body}`), { key: createPublicKey({ key: { ...key }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  return signed && claims.iss === `host_${HOST_ID}` && claims.sub === claims.iss && claims.aud === `${DIRECTORY}/api/auth/oauth2/token`
}

/** `enroll` may answer null: the control plane then registers the host as it does with no option. */
function fakeControlPlane(options: { enroll?: () => Response | null; link?: () => Response; makeLink?: () => Response | null; unlink?: () => Response; state?: Registered } = {}) {
  const calls: Call[] = []
  const state: Registered = options.state ?? { key: null, generation: 0, linked: false }
  let issued = 0
  const registrationOf = (generation: number) => ({ hostId: HOST_ID, issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY, generation, ...(state.organizationId ? { organizationId: state.organizationId } : {}) })
  const tunnel = { hostname: `h-${HOST_ID}.example.test`, proxiedPort: 34118 }
  /** The link of a host with an address: the address, with no tunnel behind it. */
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
      const refusal = options.enroll?.()
      if (refusal) return refusal
      state.key = body.publicJwk
      state.generation += 1
      // The ticket decides the kind. The address, for either kind, is where the internet reaches the host.
      if (isOrganizationTicket(body.ticket)) state.organizationId = 'org_acme'
      if (body.address) state.address = body.address
      const enrolled: EnrollHostResponse = { registration: registrationOf(state.generation), oauthClient: { clientId: `host_${HOST_ID}` } }
      return Response.json(enrolled)
    }
    if (url.endsWith('/link') && method === 'GET') {
      if (options.link) return options.link()
      const answer: HostLinkResponse = { hostId: HOST_ID, generation: state.generation, desired: state.linked ? 'linked' : 'unlinked', tunnel: state.linked ? state.address ? reach() : tunnel : null }
      return Response.json(answer)
    }
    if (url.endsWith('/link') && method === 'POST') {
      const made = options.makeLink?.()
      if (made) return made
      if (body.address) state.address = body.address
      state.linked = true
      return Response.json(state.address ? { tunnel: reach() } : { tunnel, connectorToken: 'connector-token-1' })
    }
    if (url.endsWith('/link') && method === 'DELETE') {
      if (options.unlink) return options.unlink()
      state.linked = false
      // A personal host that is unlinked has no address in Solus cloud: its next link is a tunnel.
      if (!state.organizationId) delete state.address
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
function hostOf(plane: ReturnType<typeof fakeControlPlane>, options: { proxiedPort?: number; holdsWork?: () => Promise<boolean> } = {}) {
  const connector = fakeConnector()
  const registrations: Array<string | null> = []
  let link: UplinkLinkManager | null = null
  const registrar = new HostRegistrar({
    installationId: () => 'install-1',
    hostLabel: () => 'Ashton’s MacBook',
    os: () => 'macos',
    owner: () => ({ userId: 'user_ashton', email: 'ashton@example.test' }),
    fetchImpl: plane.fetchImpl,
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
    // The prefix of the ticket says what the code is; an address says nothing about it.
    await expect(host.registrar.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY })).rejects.toThrow(/registered already/)
    await expect(host.registrar.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS })).rejects.toThrow(/registered already/)
    // A personal code with an address is a personal code: a registered host ignores it.
    await host.registrar.register({ ticket: 'set_again', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS })
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

  test('an address on a host that is linked already replaces the link: the tunnel ends, and the host is reached at the address with no connector', async () => {
    // WHY (`solus connect --address URL`): a person changes how the internet reaches their host with one command, and no tunnel stays behind.
    const plane = fakeControlPlane()
    const host = await registered(plane)
    await host.link.link()
    const before = identityOf(host)
    const asked = routeCalls(plane.calls).length

    const status = await host.link.link(MACHINE_ADDRESS)
    // One request: Solus cloud replaces the tunnel with the address, so the host is never without a link.
    expect(routeCalls(plane.calls).slice(asked).map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([`POST /v1/hosts/${HOST_ID}/link`])
    expect(routeCalls(plane.calls).at(-1)).toMatchObject({ authorization: CONTROL_TOKEN, body: { proxiedPort: 34118, address: MACHINE_ADDRESS } })
    expect(status).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, reach: 'direct', state: { observed: 'online' } })
    expect(host.connector.events).toEqual(['start', 'stop'])
    expect(host.connector.token).toBeNull()
    expect(host.link.isReachedDirectly()).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir(), 'host-link.json'), 'utf8'))).toMatchObject({ desired: 'linked', reach: 'direct', tunnel: { hostname: 'vm.acme.example.test' } })
    expect(readFileSync(join(dataDir(), 'secrets', 'uplink-tokens.json'), 'utf8')).not.toContain('connector-token-1')
    // The link changed, and nothing else.
    expect(identityOf(host)).toEqual(before)
    expect(host.registrar.current()).not.toHaveProperty('organizationId')
  })

  test('linking again with no address keeps the link that stands, and asks nobody', async () => {
    const plane = fakeControlPlane()
    const host = await registered(plane)
    await host.link.link(MACHINE_ADDRESS)
    const asked = routeCalls(plane.calls).length
    expect(await host.link.link()).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, reach: 'direct', state: { observed: 'online' } })
    expect(routeCalls(plane.calls)).toHaveLength(asked)
    expect(host.link.isReachedDirectly()).toBe(true)
  })

  test('the host does not keep its address after an unlink: a later link with no address asks for a tunnel', async () => {
    // WHY (`solus connect unlink`, then `solus connect`): the address is the link's. A host that sent an old address again would never get a tunnel back.
    const plane = fakeControlPlane()
    const host = await registered(plane)
    await host.link.link(MACHINE_ADDRESS)
    await host.link.unlink()
    expect(host.link.isReachedDirectly()).toBe(false)

    expect(await host.link.link()).toEqual({ linked: true, tunnel: plane.tunnel, state: { observed: 'offline' } })
    expect(routeCalls(plane.calls).at(-1)!.body).toEqual({ proxiedPort: 34118 })
    expect(host.connector.token).toBe('connector-token-1')
    expect(host.link.isReachedDirectly()).toBe(false)
    expect(JSON.parse(readFileSync(join(dataDir(), 'host-link.json'), 'utf8')).reach).toBe('tunnel')
  })

  test('an address that Solus cloud refuses leaves the link that stands: the tunnel and its connector stay', async () => {
    // WHY: a wrong address must not take a reachable host off the internet.
    let refuses = false
    const plane = fakeControlPlane({ makeLink: () => refuses ? Response.json({ error: 'machine_address_invalid' }, { status: 400 }) : null })
    const host = await registered(plane)
    await host.link.link()
    refuses = true
    await expect(host.link.link('https://vm.acme.example.test/path')).rejects.toThrow(/address of this machine is not valid/)
    expect(host.status().link).toMatchObject({ linked: true, tunnel: plane.tunnel })
    expect(host.link.isReachedDirectly()).toBe(false)
    expect(host.connector.events).toEqual(['start'])
  })

  test('an address that Solus cloud refuses says why', async () => {
    const plane = fakeControlPlane({ makeLink: () => Response.json({ error: 'machine_address_invalid' }, { status: 400 }) })
    const host = await registered(plane)
    await expect(host.link.link('https://vm.acme.example.test/path')).rejects.toThrow(/address of this machine is not valid/)
    expect(host.status().link).toEqual({ linked: false })
    expect(host.connector.events).toEqual([])
  })
})

describe('linking a device to Solus cloud: a new registration links (rule 9, amended)', () => {
  const dataDir = useDataDir('solus-register-and-link-test-')
  const linkPosts = (plane: ReturnType<typeof fakeControlPlane>) => plane.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/link'))

  test('a personal code with an address registers a personal host that is reached at the address: no tunnel, no connector, and it is online', async () => {
    // WHY: the code decides the kind and the address decides the reach. An address must not make a cloud machine.
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await registerAndLink(host.registrar, host.link, { ticket: 'set_ticket', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS })
    expect(routeCalls(plane.calls).map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /v1/hosts/enroll', `POST /v1/hosts/${HOST_ID}/link`])
    expect(routeCalls(plane.calls)[0]!.body).toMatchObject({ ticket: 'set_ticket', address: MACHINE_ADDRESS })
    // The address went with the ticket; Solus cloud holds it, so the link call names none.
    expect(routeCalls(plane.calls)[1]!.body).toEqual({ proxiedPort: 34118 })
    expect(host.registrar.current()).not.toHaveProperty('organizationId')
    expect(readStoredCloudMachine()).toBeNull()
    expect(host.status().link).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, reach: 'direct', state: { observed: 'online' } })
    expect(host.connector.events).toEqual([])
    expect(host.link.isReachedDirectly()).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir(), 'host-link.json'), 'utf8')).reach).toBe('direct')
    const tokens = join(dataDir(), 'secrets', 'uplink-tokens.json')
    expect(existsSync(tokens) ? readFileSync(tokens, 'utf8') : '').not.toContain('connectorToken')
  })

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

describe('a cloud machine that registered with an organization code', () => {
  const dataDir = useDataDir('solus-cloud-machine-link-test-')
  const code = { ticket: 'org_ticket', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS }
  const tokensFile = () => join(dataDir(), 'secrets', 'uplink-tokens.json')

  test('the code with an address registers the machine and links it at once: its address comes back, no connector runs, and it is online', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await registerAndLink(host.registrar, host.link, code)
    expect(routeCalls(plane.calls).map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /v1/hosts/enroll', `POST /v1/hosts/${HOST_ID}/link`])
    expect(routeCalls(plane.calls)[0]!.body).toMatchObject({ ticket: 'org_ticket', address: MACHINE_ADDRESS })
    expect(host.registrar.current()).toMatchObject({ organizationId: 'org_acme' })
    expect(host.status().link).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, reach: 'direct', state: { observed: 'online' } })
    expect(host.connector.events).toEqual([])
    // No connector token exists for it, here or in Solus cloud.
    expect(existsSync(tokensFile()) ? readFileSync(tokensFile(), 'utf8') : '').not.toContain('connectorToken')
  })

  test('the code with no address makes a cloud machine all the same, reached through a tunnel', async () => {
    // WHY: the prefix of the ticket makes the cloud machine. An operator whose machine has no public address still joins with one code.
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await registerAndLink(host.registrar, host.link, { ticket: 'org_ticket', directoryUrl: DIRECTORY })
    expect(routeCalls(plane.calls)[0]!.body).not.toHaveProperty('address')
    expect(host.registrar.current()).toMatchObject({ organizationId: 'org_acme' })
    expect(readStoredCloudMachine()).toMatchObject({ organizationId: 'org_acme' })
    expect(host.status().link).toEqual({ linked: true, tunnel: plane.tunnel, state: { observed: 'offline' } })
    expect(host.connector.events).toEqual(['start'])
    expect(host.connector.token).toBe('connector-token-1')
    expect(host.link.isReachedDirectly()).toBe(false)
  })

  test('a Solus cloud with no tunnels refuses the code that has no address, and the host says to give one', async () => {
    const plane = fakeControlPlane({ enroll: () => Response.json({ error: 'tunnel_not_configured' }, { status: 409 }) })
    const host = hostOf(plane)
    await expect(registerAndLink(host.registrar, host.link, { ticket: 'org_ticket', directoryUrl: DIRECTORY })).rejects.toThrow('This Solus cloud has no tunnels. Give the HTTPS address of this machine with `--address`.')
    expect(host.status()).toEqual({ registration: { registered: false }, link: { linked: false } })
    expect(readStoredCloudMachine()).toBeNull()
  })

  test('at boot its stored link starts with no connector token: it is online, not an error', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    const first = hostOf(fakeControlPlane({ state }))
    await registerAndLink(first.registrar, first.link, code)
    const rebooted = hostOf(fakeControlPlane({ state }))
    await rebooted.boot()
    expect(rebooted.connector.events).toEqual([])
    expect(rebooted.status().link).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, reach: 'direct', state: { observed: 'online' } })
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
    // The machine names no address again: nobody is there to give it, and Solus cloud has it.
    expect(routeCalls(plane.calls).at(-1)).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/link`, authorization: CONTROL_TOKEN })
    expect(routeCalls(plane.calls).at(-1)!.body).toEqual({ proxiedPort: 34118 })
    expect(rebooted.status().link).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, reach: 'direct', state: { observed: 'online' } })
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

  test('a personal host with no stored link asks for none at boot: an unlink stays an unlink', async () => {
    // WHY: only a cloud machine has no person to turn its link on.
    const plane = fakeControlPlane()
    await hostOf(plane).registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const unlinked = hostOf(plane)
    await unlinked.boot()
    expect(plane.calls.some((call) => call.method === 'POST' && call.url.endsWith('/link'))).toBe(false)
    expect(unlinked.status().link).toEqual({ linked: false })
  })

  test('a stored tunnel link whose connector token is gone says so; a stored link at an address needs no token', async () => {
    // WHY: the record says how the host is reached (`reach`), not the kind of the machine and
    // not the absence of a token. A tunnel cannot run without its token, on any machine.
    const tunnelState: Registered = { key: null, generation: 0, linked: false }
    const tunnelled = hostOf(fakeControlPlane({ state: tunnelState }))
    await registerAndLink(tunnelled.registrar, tunnelled.link, { ticket: 'set_ticket', directoryUrl: DIRECTORY })
    rmSync(tokensFile())
    const rebooted = hostOf(fakeControlPlane({ state: tunnelState }))
    await rebooted.boot()
    expect(rebooted.connector.events).toEqual([])
    expect(rebooted.status().link).toMatchObject({ linked: true, state: { observed: 'error', error: expect.stringContaining('tunnel credential is missing') } })

    // The same personal host, now at its own address.
    await rebooted.link.link(MACHINE_ADDRESS)
    rmSync(tokensFile(), { force: true })
    const direct = hostOf(fakeControlPlane({ state: tunnelState }))
    await direct.boot()
    expect(direct.registrar.current()).not.toHaveProperty('organizationId')
    expect(direct.connector.events).toEqual([])
    expect(direct.status().link).toEqual({ linked: true, tunnel: { hostname: 'vm.acme.example.test', proxiedPort: 34118 }, reach: 'direct', state: { observed: 'online' } })
  })

  test('the code is refused on a host that holds sessions, and nothing is linked', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane, { holdsWork: async () => true })
    await expect(registerAndLink(host.registrar, host.link, code)).rejects.toThrow(/holds sessions already/)
    expect(plane.calls).toEqual([])
    expect(host.status()).toEqual({ registration: { registered: false }, link: { linked: false } })
  })
})

describe('a data directory of a cloud machine stays one (plans/034 §2)', () => {
  const dataDir = useDataDir('solus-cloud-machine-record-test-')
  const recordFile = () => join(dataDir(), 'cloud-machine.json')

  /** A cloud machine whose registration Solus cloud ended: the record of its organization is what stays. */
  async function endedCloudMachine(state: Registered = { key: null, generation: 0, linked: false }) {
    await hostOf(fakeControlPlane({ state })).registrar.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS })
    state.key = null
    const ended = hostOf(fakeControlPlane({ state }))
    await ended.boot()
    expect(ended.registrar.current()).toBeNull()
    return state
  }

  test('each cloud enrollment writes the record of its organization, and the end of the registration does not remove it', async () => {
    // WHY: the sessions on this disk are the organization's. Without the record, a deleted
    // machine would start again as a personal host, with a pairing door and a local owner.
    expect(readStoredCloudMachine()).toBeNull()
    await endedCloudMachine()
    expect(existsSync(join(dataDir(), 'host-registration.json'))).toBe(false)
    expect(JSON.parse(readFileSync(recordFile(), 'utf8'))).toEqual({ version: 1, organizationId: 'org_acme' })
    expect(readStoredCloudMachine()).toEqual({ organizationId: 'org_acme', hasManagedCompute: undefined })
  })

  test('a personal enrollment writes no record', async () => {
    await hostOf(fakeControlPlane()).registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS })
    expect(existsSync(recordFile())).toBe(false)
  })

  test('the record keeps whether Solus cloud operates the compute', async () => {
    const plane = fakeControlPlane()
    const managed: EnrollHostResponse = { registration: { ...plane.registrationOf(1), organizationId: 'org_acme', hasManagedCompute: true }, oauthClient: { clientId: `host_${HOST_ID}` } }
    await hostOf(fakeControlPlane({ enroll: () => Response.json(managed) })).registrar.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY })
    expect(readStoredCloudMachine()).toEqual({ organizationId: 'org_acme', hasManagedCompute: true })
  })

  test('such a data directory takes no personal code: it is refused before any request', async () => {
    const state = await endedCloudMachine()
    const plane = fakeControlPlane({ state })
    const host = hostOf(plane)
    await expect(host.registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })).rejects.toMatchObject({ code: 'register-rejected', message: expect.stringMatching(/belongs to a cloud machine.*new data directory/) })
    expect(plane.calls).toEqual([])
    expect(host.registrar.current()).toBeNull()
  })

  test('such a data directory takes no registration of another organization: nothing of it is stored', async () => {
    const state = await endedCloudMachine()
    const other: EnrollHostResponse = { registration: { ...fakeControlPlane().registrationOf(2), organizationId: 'org_other' }, oauthClient: { clientId: `host_${HOST_ID}` } }
    const host = hostOf(fakeControlPlane({ state, enroll: () => Response.json(other) }))
    await expect(host.registrar.register({ ticket: 'org_other_ticket', directoryUrl: DIRECTORY })).rejects.toMatchObject({ code: 'register-rejected', message: expect.stringMatching(/another organization/) })
    expect(host.registrar.current()).toBeNull()
    expect(existsSync(join(dataDir(), 'host-registration.json'))).toBe(false)
    expect(existsSync(join(dataDir(), 'secrets', 'host-credential.json'))).toBe(false)
    expect(readStoredCloudMachine()).toMatchObject({ organizationId: 'org_acme' })
  })

  test('its own organization registers it again, also with its sessions on the disk', async () => {
    // WHY: the sessions it holds are that organization's already, so "holds work" is no reason to refuse.
    const state = await endedCloudMachine()
    let asked = 0
    const host = hostOf(fakeControlPlane({ state }), { holdsWork: async () => { asked += 1; return true } })
    await host.registrar.register({ ticket: 'org_again', directoryUrl: DIRECTORY })
    expect(host.registrar.current()).toMatchObject({ organizationId: 'org_acme', generation: 2 })
    expect(asked).toBe(0)
  })

  test('a record that cannot be read still says a cloud machine: no personal code is taken on a guess', async () => {
    writeFileSync(recordFile(), '{ not json')
    expect(readStoredCloudMachine()).toEqual({ organizationId: expect.any(String) })
    const plane = fakeControlPlane()
    await expect(hostOf(plane).registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })).rejects.toThrow(/belongs to a cloud machine/)
    // And no organization matches it, so its own organization cannot be guessed either.
    await expect(hostOf(plane).registrar.register({ ticket: 'org_ticket', directoryUrl: DIRECTORY })).rejects.toThrow(/another organization/)
    expect(existsSync(join(dataDir(), 'host-registration.json'))).toBe(false)
  })
})

describe('a machine with a link code in its environment enrolls at boot (plans/034 §3)', () => {
  const dataDir = useDataDir('solus-enroll-at-boot-test-')
  const machine = { installationId: 'install-1', label: 'Lab VM', os: 'linux' as const }
  const CODE_HOST = new URL(DIRECTORY).host
  const neverWait = async (): Promise<void> => { throw new Error('the boot must not wait here') }
  const enrollCalls = (plane: ReturnType<typeof fakeControlPlane>) => plane.calls.filter((call) => call.url.endsWith('/v1/hosts/enroll'))
  const sentKey = (call: Call) => (call.body as { publicJwk: HostPublicJwk }).publicJwk.x

  test('the code enrolls the machine before any registrar exists: the control plane it names is asked, and the registration, the key, and the cloud record are stored', async () => {
    const plane = fakeControlPlane()
    const registration = await enrollAtBoot({ code: { code: `org_ticket@${CODE_HOST}`, address: null }, machine, fetchImpl: plane.fetchImpl, wait: neverWait })
    expect(plane.calls).toHaveLength(1)
    expect(plane.calls[0]).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/enroll`, authorization: null, body: { ticket: 'org_ticket', installationId: 'install-1', label: 'Lab VM', os: 'linux', publicJwk: { kty: 'EC', crv: 'P-256' } } })
    // A machine with managed compute sends no address: Solus cloud has it from its provider.
    expect(plane.calls[0]!.body).not.toHaveProperty('address')
    expect(registration).toEqual({ ...plane.registrationOf(1), organizationId: 'org_acme' })
    expect(readStoredRegistration()).toEqual(registration)
    expect(readStoredCloudMachine()).toMatchObject({ organizationId: 'org_acme' })
    expect(JSON.parse(readFileSync(join(dataDir(), 'secrets', 'host-credential.json'), 'utf8'))).toMatchObject({ clientId: `host_${HOST_ID}`, generation: 1, privateJwk: { x: sentKey(plane.calls[0]!) } })
    // The server that then boots is registered: it proves itself with that key, and links by itself.
    const host = hostOf(plane)
    expect(host.registrar.needsRegistration()).toBe(false)
    await host.boot()
    expect(routeCalls(plane.calls).at(-1)).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/${HOST_ID}/link`, authorization: CONTROL_TOKEN })
    expect(host.status().link).toMatchObject({ linked: true })
  })

  test('the address from the environment goes with the ticket, for a personal code also', async () => {
    const plane = fakeControlPlane()
    const registration = await enrollAtBoot({ code: { code: `set_ticket@${CODE_HOST}`, address: MACHINE_ADDRESS }, machine, fetchImpl: plane.fetchImpl, wait: neverWait })
    expect(plane.calls[0]!.body).toMatchObject({ ticket: 'set_ticket', address: MACHINE_ADDRESS })
    expect(registration).not.toHaveProperty('organizationId')
    expect(readStoredCloudMachine()).toBeNull()
  })

  test('a machine that is registered already keeps its registration: the code of an earlier boot asks nobody', async () => {
    // WHY: a provider's boot input keeps the code, and its ticket is spent. A restart must not end the boot.
    const plane = fakeControlPlane()
    const first = await enrollAtBoot({ code: { code: `org_ticket@${CODE_HOST}`, address: null }, machine, fetchImpl: plane.fetchImpl, wait: neverWait })
    const key = readFileSync(join(dataDir(), 'secrets', 'host-credential.json'), 'utf8')
    expect(await enrollAtBoot({ code: { code: `org_ticket@${CODE_HOST}`, address: null }, machine, fetchImpl: plane.fetchImpl, wait: neverWait })).toBeNull()
    expect(plane.calls).toHaveLength(1)
    expect(readStoredRegistration()).toEqual(first)
    expect(readFileSync(join(dataDir(), 'secrets', 'host-credential.json'), 'utf8')).toBe(key)
  })

  test('while Solus cloud does not answer, or answers a server error, the boot waits and tries again with the same key', async () => {
    // WHY: Solus cloud answers a spent ticket again only for the key that it registered with it.
    // A new key for each attempt would lock the machine out when one answer was lost.
    let attempt = 0
    const plane = fakeControlPlane({ enroll: () => {
      attempt += 1
      if (attempt === 1) throw new Error('ECONNREFUSED')
      return attempt === 2 ? Response.json({ error: 'internal_error' }, { status: 503 }) : null
    } })
    const waits: number[] = []
    const registration = await enrollAtBoot({ code: { code: `org_ticket@${CODE_HOST}`, address: null }, machine, fetchImpl: plane.fetchImpl, wait: async (delayMs) => { waits.push(delayMs) } })
    expect(enrollCalls(plane)).toHaveLength(3)
    expect(waits).toEqual([5_000, 10_000])
    expect(new Set(enrollCalls(plane).map(sentKey)).size).toBe(1)
    expect(registration).toMatchObject({ hostId: HOST_ID, organizationId: 'org_acme' })
    expect(JSON.parse(readFileSync(join(dataDir(), 'secrets', 'host-credential.json'), 'utf8')).privateJwk.x).toBe(sentKey(plane.calls[0]!))
  })

  test('the wait doubles and stops at one minute', async () => {
    let attempt = 0
    const plane = fakeControlPlane({ enroll: () => (++attempt <= 6 ? new Response('down', { status: 502 }) : null) })
    const waits: number[] = []
    await enrollAtBoot({ code: { code: `set_ticket@${CODE_HOST}`, address: null }, machine, fetchImpl: plane.fetchImpl, wait: async (delayMs) => { waits.push(delayMs) } })
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000])
  })

  test('a refusal ends the boot: it is not tried again, and nothing is stored', async () => {
    const plane = fakeControlPlane({ enroll: () => Response.json({ error: 'invalid_ticket' }, { status: 401 }) })
    await expect(enrollAtBoot({ code: { code: `org_ticket@${CODE_HOST}`, address: null }, machine, fetchImpl: plane.fetchImpl, wait: neverWait })).rejects.toMatchObject({ code: 'register-rejected', message: expect.stringMatching(/ticket is invalid/) })
    expect(plane.calls).toHaveLength(1)
    expect(readStoredRegistration()).toBeNull()
    expect(readStoredCloudMachine()).toBeNull()
    expect(existsSync(join(dataDir(), 'secrets', 'host-credential.json'))).toBe(false)
  })

  test('an organization code on a server that holds sessions is refused, and its ticket is not sent; a new server, whose database exists already, enrolls', async () => {
    // WHY: the server opens its database before it enrolls, so the database file says nothing.
    // What counts is the session records in it: a cloud machine starts with new data.
    writeFileSync(join(dataDir(), 'solus.db'), '')
    const plane = fakeControlPlane()
    await expect(enrollAtBoot({ code: { code: `org_ticket@${CODE_HOST}`, address: null }, machine, holdsWork: async () => true, fetchImpl: plane.fetchImpl, wait: neverWait })).rejects.toMatchObject({ code: 'register-rejected', message: expect.stringMatching(/holds sessions already.*new data director/) })
    expect(plane.calls).toEqual([])
    // A personal code on a server that holds sessions enrolls: the work on it is that person's.
    expect(await enrollAtBoot({ code: { code: `set_ticket@${CODE_HOST}`, address: null }, machine, holdsWork: async () => true, fetchImpl: plane.fetchImpl, wait: neverWait })).toMatchObject({ hostId: HOST_ID })
  })

  test('an organization code on a new server enrolls although its database file exists', async () => {
    // WHY (found by a Lab run): a first boot always has a database file by the time it enrolls.
    writeFileSync(join(dataDir(), 'solus.db'), '')
    expect(await enrollAtBoot({ code: { code: `org_ticket@${CODE_HOST}`, address: null }, machine, holdsWork: async () => false, fetchImpl: fakeControlPlane().fetchImpl, wait: neverWait })).toMatchObject({ organizationId: 'org_acme' })
  })

  test('a cloud machine whose registration ended enrolls again with a code of its organization, with its database on the disk; a personal code is refused with no request', async () => {
    const state: Registered = { key: null, generation: 0, linked: false }
    await enrollAtBoot({ code: { code: `org_ticket@${CODE_HOST}`, address: null }, machine, fetchImpl: fakeControlPlane({ state }).fetchImpl, wait: neverWait })
    writeFileSync(join(dataDir(), 'solus.db'), '')
    rmSync(join(dataDir(), 'host-registration.json'))
    const plane = fakeControlPlane({ state })
    await expect(enrollAtBoot({ code: { code: `set_ticket@${CODE_HOST}`, address: null }, machine, fetchImpl: plane.fetchImpl, wait: neverWait })).rejects.toThrow(/belongs to a cloud machine/)
    expect(plane.calls).toEqual([])
    expect(await enrollAtBoot({ code: { code: `org_again@${CODE_HOST}`, address: null }, machine, fetchImpl: plane.fetchImpl, wait: neverWait })).toMatchObject({ organizationId: 'org_acme', generation: 2 })
  })

  test('a code that does not name its Solus cloud is refused: a boot has no default to fall back on', async () => {
    const plane = fakeControlPlane()
    await expect(enrollAtBoot({ code: { code: 'org_ticket', address: null }, machine, fetchImpl: plane.fetchImpl, wait: neverWait })).rejects.toMatchObject({ code: 'register-rejected', message: expect.stringMatching(/does not name its Solus cloud/) })
    expect(plane.calls).toEqual([])
  })
})

describe('the calls a client makes (`uplinkRegister`, `uplinkLink`)', () => {
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
  const lastLinkBody = (plane: ReturnType<typeof fakeControlPlane>) => plane.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/link')).at(-1)?.body

  test('carries the machine address of an organization code, and the machine is linked at its address', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await handlersOf(host).get('uplinkRegister')!([{ ticket: ' org_ticket ', directoryUrl: ` ${DIRECTORY} `, address: ` ${MACHINE_ADDRESS} ` }])
    expect(enrollBody(plane)).toMatchObject({ ticket: 'org_ticket', address: MACHINE_ADDRESS })
    expect(host.status()).toMatchObject({ registration: { registered: true, registration: { organizationId: 'org_acme' } }, link: { linked: true, state: { observed: 'online' } } })
  })

  test('an organization code ends the owner connections of the server, because nobody owns a cloud machine', async () => {
    // WHY: the caller was admitted as the local owner before the registration. That standing must not outlive it.
    let ended = 0
    const cloud = hostOf(fakeControlPlane())
    await handlersOf(cloud, () => { ended += 1 }).get('uplinkRegister')!([{ ticket: 'org_ticket', directoryUrl: DIRECTORY }])
    expect(ended).toBe(1)
  })

  test('a personal code with an address leaves the owner connected: the address does not make a cloud machine', async () => {
    let ended = 0
    const personal = hostOf(fakeControlPlane())
    await handlersOf(personal, () => { ended += 1 }).get('uplinkRegister')!([{ ticket: 'set_ticket', directoryUrl: DIRECTORY, address: MACHINE_ADDRESS }])
    expect(personal.registrar.current()).not.toHaveProperty('organizationId')
    expect(ended).toBe(0)
  })

  test('an empty address is no address: the host gets a tunnel', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await handlersOf(host).get('uplinkRegister')!([{ ticket: 'set_ticket', directoryUrl: DIRECTORY, address: '   ' }])
    expect(enrollBody(plane)).not.toHaveProperty('address')
    expect(host.status().link).toMatchObject({ linked: true, tunnel: plane.tunnel })
  })

  test('`uplinkLink` passes the address a client gives, trimmed, and none when it is empty or absent', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    const handlers = handlersOf(host)
    await host.registrar.register({ ticket: 'set_ticket', directoryUrl: DIRECTORY })

    expect(await handlers.get('uplinkLink')!([` ${MACHINE_ADDRESS} `])).toMatchObject({ link: { linked: true, tunnel: { hostname: 'vm.acme.example.test' }, state: { observed: 'online' } } })
    expect(lastLinkBody(plane)).toEqual({ proxiedPort: 34118, address: MACHINE_ADDRESS })

    await handlers.get('uplinkUnlink')!([])
    await handlers.get('uplinkLink')!(['   '])
    expect(lastLinkBody(plane)).toEqual({ proxiedPort: 34118 })
    await handlers.get('uplinkUnlink')!([])
    expect(await handlers.get('uplinkLink')!([])).toMatchObject({ link: { linked: true, tunnel: plane.tunnel } })
    expect(lastLinkBody(plane)).toEqual({ proxiedPort: 34118 })
  })

  test('no call takes an organization back from a host', () => {
    const handlers = handlersOf(hostOf(fakeControlPlane()))
    expect([...handlers.keys()].sort()).toEqual(['hostSelfTest', 'uplinkLink', 'uplinkRegister', 'uplinkStatus', 'uplinkUnlink'])
    expect(RPC_INVOKE_METHODS).not.toContain('uplinkDetachOrganization')
  })
})

describe('a host with nothing stored', () => {
  useDataDir('solus-empty-host-boot-test-')

  test('a personal host with nothing stored does nothing at boot', async () => {
    const plane = fakeControlPlane()
    const host = hostOf(plane)
    await host.boot()
    expect(plane.calls).toHaveLength(0)
    expect(host.status()).toEqual({ registration: { registered: false }, link: { linked: false } })
  })
})
