import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPublicKey, verify } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UplinkLinkError, UplinkLinkManager, SUPERSEDED_MESSAGE, type UplinkConnectorHandle, type UplinkLinkDeps } from '@solus/server/transport/uplink/link'
import { CLIENT_ASSERTION_TYPE, type EnrollHostResponse, type HostLinkEnv, type HostPublicJwk, type UplinkStatus } from '@solus/contracts/uplink'
import { uplinkStatusDescription } from '../../packages/workspace-ui/src/contexts/connections/host-routes'

// docs/plans/personal-uplink.md H2/H4: desired state is written before anything
// acts on it, so a crash between the control plane, the connector, and the secret
// store resumes correctly at boot; and a copy of the host that lost the generation
// race stops itself. The host proves itself with its own key (docs/adr/0001-standard-authentication.md
// §2.2 rule 8): every link route takes its control token, got with a client assertion.

const DIRECTORY = 'https://app.example.test'

interface Call { method: string; url: string; body: unknown; authorization: string | null }

/** What the account plane registered for the host's client: the public half of its key. Planes of one test may share it. */
interface Registration { key: HostPublicJwk | null }

/** Whether a client assertion is signed by the registered key, for this client, at the token endpoint. */
function assertionValid(assertion: string, key: HostPublicJwk | null): boolean {
  const [header, body, signature] = assertion.split('.')
  if (!key || !header || !body || !signature) return false
  const signed = verify('sha256', Buffer.from(`${header}.${body}`), { key: createPublicKey({ key: { ...key }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  return signed && claims.iss === 'host_abcdefghijklmnop' && claims.sub === claims.iss && claims.aud === `${DIRECTORY}/api/auth/oauth2/token`
}

function fakeControlPlane(options: {
  enroll?: () => Response
  link?: () => Response
  unlink?: () => Response
  credential?: () => Response
  registration?: Registration
} = {}) {
  const calls: Call[] = []
  const registration = options.registration ?? { key: null }
  let issued = 0
  const enrolled: EnrollHostResponse = {
    link: {
      hostId: 'abcdefghijklmnop', issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY,
      hostname: 'h-abcdefghijklmnop.example.test', proxiedPort: 34118, connectionGeneration: 1,
    },
    connectorToken: 'connector-token-1',
    oauthClient: { clientId: 'host_abcdefghijklmnop' },
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const raw = init?.body ? String(init.body) : null
    const body = raw === null ? null : raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
    calls.push({ method, url, body, authorization: headers.get('authorization') })
    if (url === `${DIRECTORY}/api/auth/oauth2/token`) {
      // The client credentials grant: a control token only for an assertion the registered key signed.
      const valid = body?.grant_type === 'client_credentials' && body.client_assertion_type === CLIENT_ASSERTION_TYPE && assertionValid(body.client_assertion, registration.key)
      return valid ? Response.json({ access_token: `control-${++issued}`, expires_in: 300 }) : Response.json({ error: 'invalid_client' }, { status: 401 })
    }
    if (url.endsWith('/v1/hosts/enroll')) {
      if (options.enroll) return options.enroll()
      registration.key = body.publicJwk
      return Response.json(enrolled)
    }
    if (url.endsWith('/credential') && method === 'POST') {
      if (options.credential) return options.credential()
      registration.key = body.publicJwk
      return Response.json({ oauthClient: { clientId: 'host_abcdefghijklmnop' } })
    }
    if (url.endsWith('/link') && method === 'GET') return options.link?.() ?? Response.json({ hostId: enrolled.link.hostId, desired: 'linked', connectionGeneration: 1, hostname: enrolled.link.hostname, proxiedPort: 34118 })
    if (url.endsWith('/link') && method === 'DELETE') return options.unlink?.() ?? new Response(null, { status: 204 })
    return new Response('not found', { status: 404 })
  }
  return { calls, fetchImpl, enrolled, registration }
}

/** The calls a host made to the account plane's routes, without its token requests. */
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

describe('the host side of the link', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-uplink-link-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  function manager(plane: ReturnType<typeof fakeControlPlane>, connector = fakeConnector(), proxiedPort = 34118, extra: Partial<UplinkLinkDeps> = {}) {
    const linkChanges: Array<string | null> = []
    const instance = new UplinkLinkManager({
      installationId: () => 'install-1',
      hostLabel: () => 'Ashton’s MacBook',
      os: () => 'macos',
      proxiedPort: () => proxiedPort,
      connector,
      fetchImpl: plane.fetchImpl,
      onLinkChanged: (link) => linkChanges.push(link?.hostId ?? null),
      ...extra,
    })
    return { instance, connector, linkChanges }
  }

  test('linking enrols with the ticket and the public half of a new key, keeps the secrets out of the link file, and starts the connector', async () => {
    const plane = fakeControlPlane()
    const { instance, connector, linkChanges } = manager(plane)

    const status = await instance.link({ ticket: 'set_ticket', directoryUrl: `${DIRECTORY}/` })
    expect(status.linked).toBe(true)
    if (status.linked) {
      expect(status.link.hostname).toBe('h-abcdefghijklmnop.example.test')
      expect(status.state).toEqual({ observed: 'offline' })
    }
    expect(plane.calls[0]).toMatchObject({
      method: 'POST', url: `${DIRECTORY}/v1/hosts/enroll`,
      body: { ticket: 'set_ticket', installationId: 'install-1', label: 'Ashton’s MacBook', os: 'macos', proxiedPort: 34118, publicJwk: { kty: 'EC', crv: 'P-256' } },
    })
    // Only the public half is sent; the private half stays in the secret store.
    const sent = plane.calls[0]!.body as { publicJwk: Record<string, string> }
    expect(sent.publicJwk).not.toHaveProperty('d')
    const kept = readFileSync(join(dataDir, 'secrets', 'host-credential.json'), 'utf8')
    expect(JSON.parse(kept)).toMatchObject({ version: 1, clientId: 'host_abcdefghijklmnop', generation: 1, privateJwk: { x: sent.publicJwk.x, d: expect.any(String) } })
    expect(instance.credential()?.clientId).toBe('host_abcdefghijklmnop')
    expect(connector.events).toEqual(['start'])
    expect(connector.token).toBe('connector-token-1')
    const linkFile = readFileSync(join(dataDir, 'uplink-link.json'), 'utf8')
    expect(linkFile).toContain('"desired": "linked"')
    expect(linkFile).not.toContain('connector-token-1')
    expect(linkFile).not.toContain('"d"')
    expect(existsSync(join(dataDir, 'secrets', 'uplink-tokens.json'))).toBe(true)
    expect(linkChanges).toEqual(['abcdefghijklmnop'])
  })

  test('a linked host does not enrol again: another code is only an organization attachment, which this control plane refuses', async () => {
    const plane = fakeControlPlane()
    const { instance } = manager(plane)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    await expect(instance.link({ ticket: 'set_other', directoryUrl: DIRECTORY })).rejects.toBeInstanceOf(UplinkLinkError)
    expect(plane.calls.filter((call) => call.url.endsWith('/v1/hosts/enroll'))).toHaveLength(1)
    expect(routeCalls(plane.calls).at(-1)).toMatchObject({ url: `${DIRECTORY}/v1/hosts/abcdefghijklmnop/organizations/attach`, authorization: CONTROL_TOKEN })
  })

  test('a refused enrolment says why and leaves nothing behind', async () => {
    const refusing = fakeControlPlane({ enroll: () => Response.json({ error: 'invalid_ticket' }, { status: 401 }) })
    const { instance, connector } = manager(refusing)
    await expect(instance.link({ ticket: 'set_bad', directoryUrl: DIRECTORY })).rejects.toThrow(/ticket is invalid/)
    expect(instance.status()).toEqual({ linked: false })
    expect(connector.events).toEqual([])
    expect(existsSync(join(dataDir, 'uplink-link.json'))).toBe(false)
  })

  test('without a tunnel listener nothing is enrolled', async () => {
    const plane = fakeControlPlane()
    const { instance } = manager(plane, fakeConnector(), 0)
    await expect(instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })).rejects.toThrow(/tunnel listener/)
    expect(plane.calls).toHaveLength(0)
  })

  test('unlinking stops the connector, tells the control plane with the host’s control token, then forgets the key and the secrets', async () => {
    const plane = fakeControlPlane()
    const { instance, connector, linkChanges } = manager(plane)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })

    const status = await instance.unlink()
    expect(status).toEqual({ linked: false })
    expect(connector.events).toEqual(['start', 'stop'])
    const unlinkCall = plane.calls.find((call) => call.method === 'DELETE')
    expect(unlinkCall).toMatchObject({ url: `${DIRECTORY}/v1/hosts/abcdefghijklmnop/link`, authorization: CONTROL_TOKEN })
    expect(existsSync(join(dataDir, 'uplink-link.json'))).toBe(false)
    expect(existsSync(join(dataDir, 'secrets', 'uplink-tokens.json'))).toBe(false)
    expect(existsSync(join(dataDir, 'secrets', 'host-credential.json'))).toBe(false)
    expect(linkChanges.at(-1)).toBeNull()
  })

  test('an unlink the control plane never saw is finished at the next boot', async () => {
    let planeDown = true
    const plane = fakeControlPlane({ unlink: () => { if (planeDown) throw new Error('ECONNREFUSED'); return new Response(null, { status: 204 }) } })
    const { instance, connector } = manager(plane)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })

    // Desired state flips first; the connector is down; the control plane is not told.
    const status = await instance.unlink()
    expect(status).toEqual({ linked: false })
    expect(connector.events).toEqual(['start', 'stop'])
    expect(readFileSync(join(dataDir, 'uplink-link.json'), 'utf8')).toContain('"desired": "unlinked"')
    expect(existsSync(join(dataDir, 'secrets', 'uplink-tokens.json'))).toBe(true)

    // Reboot: a new manager reads the desired state and retries.
    planeDown = false
    const rebooted = manager(plane, fakeConnector())
    expect(rebooted.instance.status()).toEqual({ linked: false })
    await rebooted.instance.resume()
    expect(plane.calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
    expect(existsSync(join(dataDir, 'uplink-link.json'))).toBe(false)
    expect(existsSync(join(dataDir, 'secrets', 'uplink-tokens.json'))).toBe(false)
    expect(rebooted.connector.events).toEqual([])
  })

  test('at boot a linked host checks its generation, then runs the connector', async () => {
    const plane = fakeControlPlane()
    const first = manager(plane)
    await first.instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })

    const rebooted = manager(plane, fakeConnector())
    await rebooted.instance.resume()
    const check = plane.calls.find((call) => call.method === 'GET')
    expect(check).toMatchObject({ url: `${DIRECTORY}/v1/hosts/abcdefghijklmnop/link`, authorization: CONTROL_TOKEN })
    expect(rebooted.connector.events).toEqual(['start'])
  })

  test('a linked host whose port another process took says so instead of running a dead tunnel', async () => {
    // WHY: the tunnel's ingress points at the enrolled port; a connector on a host
    // that could not bind it would show "online" while every request 502s.
    const plane = fakeControlPlane()
    const first = manager(plane)
    await first.instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })

    const rebooted = manager(plane, fakeConnector(), 0)
    await rebooted.instance.resume()
    expect(rebooted.connector.events).toEqual([])
    const status = rebooted.instance.status()
    if (status.linked) expect(status.state).toMatchObject({ observed: 'error', error: expect.stringContaining('34118') })
  })

  test.each(['network', 'server', 'invalid response'])('a %s failure at boot keeps the link and reports the offline tunnel in Settings', async (failure) => {
    const plane = fakeControlPlane({ link: () => {
      if (failure === 'network') throw new Error('ECONNREFUSED')
      if (failure === 'server') return new Response(null, { status: 503 })
      return Response.json({})
    } })
    await manager(plane).instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const rebooted = manager(plane)

    await expect(rebooted.instance.resume()).resolves.toBeUndefined()

    expect(rebooted.connector.events).toEqual([])
    const status = rebooted.instance.status()
    expect(status).toMatchObject({ linked: true, state: { observed: 'error', error: expect.stringContaining('could not verify') } })
    expect(uplinkStatusDescription(status)).toContain('tunnel offline')
    expect(uplinkStatusDescription(status)).toContain('use Solus locally')
    expect(existsSync(join(dataDir, 'uplink-link.json'))).toBe(true)
  })

  test('connector startup failure does not reject recovery and a later restart can recover', async () => {
    const plane = fakeControlPlane()
    await manager(plane).instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const connector = fakeConnector()
    connector.start = () => { throw new Error('binary lookup failed') }
    const rebooted = manager(plane, connector)

    await expect(rebooted.instance.resume()).resolves.toBeUndefined()
    expect(rebooted.instance.status()).toMatchObject({ linked: true, state: { observed: 'error', error: expect.stringContaining('could not start') } })

    const recovered = manager(plane)
    await recovered.instance.resume()
    expect(recovered.connector.events).toEqual(['start'])
    expect(uplinkStatusDescription(recovered.instance.status())).not.toContain('Reachable')
    recovered.instance.handleConnectorObservation({ observed: 'online' })
    expect(uplinkStatusDescription(recovered.instance.status())).toContain('tunnel online')
    expect(uplinkStatusDescription(recovered.instance.status())).not.toContain('tunnel offline')
  })

  test('an insecure control-plane address is refused at enrolment', async () => {
    // WHY: the host will fetch signing keys from the JWKS URL; an http: one would let
    // anyone on the path hand it a key.
    const plane = fakeControlPlane()
    const insecure = fakeControlPlane({
      enroll: () => Response.json({ ...plane.enrolled, link: { ...plane.enrolled.link, jwksUrl: 'http://app.example.test/api/auth/jwks' } }),
    })
    const { instance, connector } = manager(insecure)
    await expect(instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })).rejects.toThrow(/insecure/)
    expect(connector.events).toEqual([])
    expect(instance.status()).toEqual({ linked: false })
  })

  test('a restored copy with an old generation stays offline and says it was superseded', async () => {
    const plane = fakeControlPlane()
    const first = manager(plane)
    await first.instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })

    // The control plane no longer accepts this copy's control token: a newer copy took over.
    const superseding = fakeControlPlane({ registration: plane.registration, link: () => Response.json({ error: 'invalid_host_credential' }, { status: 401 }) })
    const rebooted = manager(superseding, fakeConnector())
    await rebooted.instance.resume()
    expect(rebooted.connector.events).toEqual([])
    // A link the cloud rejected is no link: a client must not offer what needs one (a live
    // session Share), and Settings must offer Link again. The reason stays visible.
    expect(rebooted.instance.status()).toEqual({ linked: false, error: SUPERSEDED_MESSAGE })

    // A newer generation in the record means the same.
    const newer = fakeControlPlane({ registration: plane.registration, link: () => Response.json({ hostId: 'abcdefghijklmnop', desired: 'linked', connectionGeneration: 2, hostname: 'h', proxiedPort: 34118 }) })
    const other = manager(newer, fakeConnector())
    await other.instance.resume()
    expect(other.connector.events).toEqual([])
  })

  test('a copy whose key the control plane no longer knows (linked again elsewhere) is superseded and asks nothing more', async () => {
    // WHY: relinking registers a new key; the old key gets no control token, so the old copy stops (ADR 0001 §2.2 rule 8).
    const plane = fakeControlPlane()
    await manager(plane).instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const relinkedElsewhere = fakeControlPlane({ registration: { key: null } })
    const rebooted = manager(relinkedElsewhere, fakeConnector())
    await rebooted.instance.resume()
    expect(rebooted.connector.events).toEqual([])
    expect(rebooted.instance.status()).toEqual({ linked: false, error: SUPERSEDED_MESSAGE })
    expect(routeCalls(relinkedElsewhere.calls)).toEqual([])
  })

  test('the control token is kept until a minute before its end, then a new one is got with a new assertion', async () => {
    const plane = fakeControlPlane()
    const { instance } = manager(plane)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const credential = instance.credential()!
    expect(await credential.hostAccessToken()).toBe('control-1')
    expect(await credential.hostAccessToken()).toBe('control-1')
    expect(plane.calls.filter((call) => call.url.endsWith('/oauth2/token'))).toHaveLength(1)
  })

  test('a link Solus cloud rejected is linked anew, not attached with its dead token', async () => {
    const plane = fakeControlPlane()
    await manager(plane).instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    const rejecting = fakeControlPlane({ registration: plane.registration, link: () => Response.json({ error: 'invalid_host_credential' }, { status: 401 }) })
    const rebooted = manager(rejecting, fakeConnector())
    await rebooted.instance.resume()

    const status = await rebooted.instance.link({ ticket: 'set_again', directoryUrl: DIRECTORY })
    expect(status.linked && status.state).toEqual({ observed: 'offline' })
    expect(rejecting.calls.some((call) => call.url.endsWith('/organizations/attach'))).toBe(false)
    expect(rejecting.calls.at(-1)).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/enroll`, body: { ticket: 'set_again' } })
    // Linking again makes a new key.
    expect((rejecting.calls.at(-1)!.body as { publicJwk: { x: string } }).publicJwk.x).not.toBe((plane.calls[0]!.body as { publicJwk: { x: string } }).publicJwk.x)
  })

  test('what the connector observes is the status line, and stays on this host', async () => {
    const plane = fakeControlPlane()
    const { instance } = manager(plane)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    instance.handleConnectorObservation({ observed: 'online' })
    const status = instance.status()
    if (status.linked) expect(status.state.observed).toBe('online')
    expect(plane.calls.map((call) => call.method)).toEqual(['POST'])
  })

  test('the tunnel coming up after the link was answered is announced, so no client waits for a reload', async () => {
    const plane = fakeControlPlane()
    const announced: UplinkStatus[] = []
    const { instance } = manager(plane, fakeConnector(), 34118, { onStatusChanged: (status) => announced.push(status) })

    const answered = await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    if (answered.linked) expect(answered.state.observed).toBe('offline')
    instance.handleConnectorObservation({ observed: 'online' })
    const last = announced.at(-1)
    expect(last?.linked).toBe(true)
    if (last?.linked) expect(last.state).toEqual({ observed: 'online' })

    await instance.unlink()
    expect(announced.at(-1)).toEqual({ linked: false })
  })
})

// docs/plans/managed-hosts.md §2, ADR 0001 §3.4: a managed host stores the link the
// control plane put in its environment, at first boot and again whenever a newer
// generation arrives; a record at the same generation wins over the (stale)
// environment. At its first boot of a link it makes its own key and registers the
// public half with the one-time ticket the link carries. No person, no enrollment.
describe('the managed link from the environment', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-managed-link-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  function managedManager(plane: ReturnType<typeof fakeControlPlane>, envLink: HostLinkEnv | null) {
    const connector = fakeConnector()
    const instance = new UplinkLinkManager({
      installationId: () => 'managed:host-1',
      hostLabel: () => 'Acme host',
      os: () => 'linux',
      proxiedPort: () => 34118,
      connector,
      fetchImpl: plane.fetchImpl,
      provisionedLink: () => envLink,
    })
    return { instance, connector }
  }

  const envOf = (plane: ReturnType<typeof fakeControlPlane>, generation = 1): HostLinkEnv => ({
    link: { ...plane.enrolled.link, connectionGeneration: generation },
    credentialTicket: `hct_ticket-${generation}`,
  })

  test('the first boot makes a key, registers its public half with the ticket, and is reached directly: no connector', async () => {
    const plane = fakeControlPlane()
    const { instance, connector } = managedManager(plane, envOf(plane))
    await instance.resume()
    expect(plane.calls).toHaveLength(1)
    expect(plane.calls[0]).toMatchObject({ method: 'POST', url: `${DIRECTORY}/v1/hosts/abcdefghijklmnop/credential`, authorization: null, body: { credentialTicket: 'hct_ticket-1', publicJwk: { kty: 'EC', crv: 'P-256' } } })
    expect((plane.calls[0]!.body as { publicJwk: object }).publicJwk).not.toHaveProperty('d')
    expect(connector.events).toEqual([])
    expect(readFileSync(join(dataDir, 'uplink-link.json'), 'utf8')).toContain('"desired": "linked"')
    expect(instance.status()).toMatchObject({ linked: true, link: { connectionGeneration: 1 }, state: { observed: 'online' } })
    // The key it registered proves it: its control token comes with an assertion that key signed.
    expect(await instance.credential()!.hostAccessToken()).toBe('control-1')
  })

  test('a boot whose registration was not answered sends the same key again, and links once it is', async () => {
    // WHY: the ticket works once; a key made anew at each boot could never be registered after a lost answer.
    let down = true
    const plane = fakeControlPlane({ credential: () => { if (down) throw new Error('ECONNREFUSED'); return Response.json({ oauthClient: { clientId: 'host_abcdefghijklmnop' } }) } })
    const env = envOf(plane)
    const first = managedManager(plane, env)
    await first.instance.resume()
    expect(first.instance.status()).toEqual({ linked: false })
    down = false
    const second = managedManager(plane, env)
    await second.instance.resume()
    const keys = plane.calls.map((call) => (call.body as { publicJwk: { x: string } }).publicJwk.x)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1]!)
    expect(second.instance.status()).toMatchObject({ linked: true })
  })

  test('a later boot with a record at the same generation ignores the environment and takes the ordinary path', async () => {
    // WHY: the machine keeps its env across restarts; the record on the volume is the
    // truth, and the generation check is what tells a superseded copy to stop.
    const plane = fakeControlPlane()
    await managedManager(plane, envOf(plane)).instance.resume()
    const rebooted = managedManager(plane, envOf(plane))
    await rebooted.instance.resume()
    expect(routeCalls(plane.calls).map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${DIRECTORY}/v1/hosts/abcdefghijklmnop/credential`,
      `GET ${DIRECTORY}/v1/hosts/abcdefghijklmnop/link`,
    ])
    expect(routeCalls(plane.calls)[1]).toMatchObject({ authorization: CONTROL_TOKEN })
    expect(rebooted.instance.status()).toMatchObject({ linked: true, state: { observed: 'online' } })
  })

  test('an environment link with a newer generation replaces the record with a new key: a recreated machine adopts it', async () => {
    const plane = fakeControlPlane()
    await managedManager(plane, envOf(plane)).instance.resume()
    const recreated = managedManager(plane, envOf(plane, 2))
    await recreated.instance.resume()
    const registrations = plane.calls.filter((call) => call.url.endsWith('/credential'))
    expect(registrations).toHaveLength(2)
    expect(registrations[1]).toMatchObject({ body: { credentialTicket: 'hct_ticket-2' } })
    const keys = registrations.map((call) => (call.body as { publicJwk: { x: string } }).publicJwk.x)
    expect(keys[1]).not.toBe(keys[0]!)
    expect(recreated.instance.status()).toMatchObject({ linked: true, link: { connectionGeneration: 2 } })
  })

  test('a refused ticket links nothing', async () => {
    const plane = fakeControlPlane({ credential: () => Response.json({ error: 'invalid_ticket' }, { status: 401 }) })
    const { instance } = managedManager(plane, envOf(plane))
    await instance.resume()
    expect(instance.status()).toEqual({ linked: false })
    expect(existsSync(join(dataDir, 'uplink-link.json'))).toBe(false)
  })

  test('a personal host with nothing in its environment does nothing at boot', async () => {
    const plane = fakeControlPlane()
    const { instance } = managedManager(plane, null)
    await instance.resume()
    expect(plane.calls).toEqual([])
    expect(instance.status()).toEqual({ linked: false })
  })
})
