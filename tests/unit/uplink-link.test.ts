import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UplinkLinkError, UplinkLinkManager, SUPERSEDED_MESSAGE, type UplinkConnectorHandle } from '@solus/server/server/uplink/link'
import type { EnrollHostResponse } from '@solus/contracts/uplink'

// docs/plans/personal-uplink.md H2/H4: desired state is written before anything
// acts on it, so a crash between the control plane, the connector, and the secret
// store resumes correctly at boot; and a copy of the host that lost the generation
// race stops itself.

const DIRECTORY = 'https://app.example.test'

interface Call { method: string; url: string; body: unknown; authorization: string | null }

function fakeControlPlane(options: {
  enroll?: () => Response
  link?: () => Response
  unlink?: () => Response
} = {}) {
  const calls: Call[] = []
  const enrolled: EnrollHostResponse = {
    link: {
      hostId: 'abcdefghijklmnop', issuer: DIRECTORY, jwksUrl: `${DIRECTORY}/api/auth/jwks`, directoryUrl: DIRECTORY,
      hostname: 'h-abcdefghijklmnop.example.test', proxiedPort: 34118, connectionGeneration: 1,
    },
    connectorToken: 'connector-token-1',
    hostToken: 'sht_host-token-1',
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, authorization: headers.get('authorization') })
    if (url.endsWith('/v1/hosts/enroll')) return options.enroll?.() ?? Response.json(enrolled)
    if (url.endsWith('/link') && method === 'GET') return options.link?.() ?? Response.json({ hostId: enrolled.link.hostId, desired: 'linked', connectionGeneration: 1, hostname: enrolled.link.hostname, proxiedPort: 34118 })
    if (url.endsWith('/link') && method === 'DELETE') return options.unlink?.() ?? new Response(null, { status: 204 })
    return new Response('not found', { status: 404 })
  }
  return { calls, fetchImpl, enrolled }
}

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

  function manager(plane: ReturnType<typeof fakeControlPlane>, connector = fakeConnector(), proxiedPort = 34118) {
    const linkChanges: Array<string | null> = []
    const instance = new UplinkLinkManager({
      installationId: () => 'install-1',
      hostLabel: () => 'Ashton’s MacBook',
      os: () => 'macos',
      proxiedPort: () => proxiedPort,
      connector,
      fetchImpl: plane.fetchImpl,
      onLinkChanged: (link) => linkChanges.push(link?.hostId ?? null),
    })
    return { instance, connector, linkChanges }
  }

  test('linking enrols with the ticket, keeps the tokens out of the link file, and starts the connector', async () => {
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
      body: { ticket: 'set_ticket', installationId: 'install-1', label: 'Ashton’s MacBook', os: 'macos', proxiedPort: 34118 },
    })
    expect(connector.events).toEqual(['start'])
    expect(connector.token).toBe('connector-token-1')
    const linkFile = readFileSync(join(dataDir, 'uplink-link.json'), 'utf8')
    expect(linkFile).toContain('"desired": "linked"')
    expect(linkFile).not.toContain('connector-token-1')
    expect(linkFile).not.toContain('sht_')
    expect(existsSync(join(dataDir, 'secrets', 'uplink-tokens.json'))).toBe(true)
    expect(linkChanges).toEqual(['abcdefghijklmnop'])
  })

  test('a linked host refuses to link again', async () => {
    const plane = fakeControlPlane()
    const { instance } = manager(plane)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })
    await expect(instance.link({ ticket: 'set_other', directoryUrl: DIRECTORY })).rejects.toBeInstanceOf(UplinkLinkError)
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

  test('unlinking stops the connector, tells the control plane with the host token, then forgets the secrets', async () => {
    const plane = fakeControlPlane()
    const { instance, connector, linkChanges } = manager(plane)
    await instance.link({ ticket: 'set_ticket', directoryUrl: DIRECTORY })

    const status = await instance.unlink()
    expect(status).toEqual({ linked: false })
    expect(connector.events).toEqual(['start', 'stop'])
    const unlinkCall = plane.calls.find((call) => call.method === 'DELETE')
    expect(unlinkCall).toMatchObject({ url: `${DIRECTORY}/v1/hosts/abcdefghijklmnop/link`, authorization: 'Bearer sht_host-token-1' })
    expect(existsSync(join(dataDir, 'uplink-link.json'))).toBe(false)
    expect(existsSync(join(dataDir, 'secrets', 'uplink-tokens.json'))).toBe(false)
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
    expect(check).toMatchObject({ url: `${DIRECTORY}/v1/hosts/abcdefghijklmnop/link`, authorization: 'Bearer sht_host-token-1' })
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

    // The control plane no longer knows this copy's token: a newer copy took over.
    const superseding = fakeControlPlane({ link: () => Response.json({ error: 'invalid_host_token' }, { status: 401 }) })
    const rebooted = manager(superseding, fakeConnector())
    await rebooted.instance.resume()
    expect(rebooted.connector.events).toEqual([])
    const status = rebooted.instance.status()
    expect(status.linked).toBe(true)
    if (status.linked) expect(status.state).toEqual({ observed: 'error', error: SUPERSEDED_MESSAGE })

    // A newer generation in the record means the same.
    const newer = fakeControlPlane({ link: () => Response.json({ hostId: 'abcdefghijklmnop', desired: 'linked', connectionGeneration: 2, hostname: 'h', proxiedPort: 34118 }) })
    const other = manager(newer, fakeConnector())
    await other.instance.resume()
    expect(other.connector.events).toEqual([])
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
})
