import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { HostRegistrationRequest, UplinkStatus } from '@solus/contracts/uplink'
import { parseMachineAddress, readCloudMachineRecord, readLinkReach } from '../../apps/cli/src/lib/cloud-machine'
import { connectHost, disconnectHost, type ConnectChoice, type ConnectDeps, type ConnectReporter, type LocalHostApi } from '../../apps/cli/src/lib/connect'
import { describeCloudMachine, describeConnection } from '../../apps/cli/src/lib/onboarding'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// plans/034-one-cloud-machine-kind.md: every machine joins one way. The code decides
// what the server is: a personal code (`set_…`) registers it to a person, an
// organization code (`org_…`) makes it a cloud machine of one organization. The
// address decides how the internet reaches it, for both kinds: with `--address` there
// is no tunnel, so the CLI installs no cloudflared; without it the server gets a
// tunnel. A cloud machine enrolls and links inside the one `uplinkRegister` call, and
// after that call it refuses its local socket: the CLI makes no later call, and reads
// what it says about the machine from the records in the data directory.

const REGISTRATION = { hostId: 'h1', issuer: ISSUER, jwksUrl: `${ISSUER}/api/auth/jwks`, directoryUrl: ISSUER, generation: 1, apiUrl: 'https://api.test' }
const UNREGISTERED: UplinkStatus = { registration: { registered: false }, link: { linked: false } }
const PERSONAL: UplinkStatus = {
  registration: { registered: true, registration: REGISTRATION, owner: { userId: 'user-1', email: 'ada@example.test' } },
  link: { linked: true, tunnel: { hostname: 'h-h1.solus.sh', proxiedPort: 34118 }, state: { observed: 'online' } },
}
const UNLINKED: UplinkStatus = { ...PERSONAL, link: { linked: false } }
const ADDRESS = 'https://machine.example.com'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'solus-cli-cloud-machine-')) })
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })

/** A server's local socket: answers `current`, and records every call that changes it. */
function fakeServer(current: UplinkStatus, registered: UplinkStatus) {
  const calls: string[] = []
  const registers: HostRegistrationRequest[] = []
  /** The address of each `uplinkLink` call; null for a call with none. */
  const links: Array<string | null> = []
  const api: LocalHostApi = {
    uplinkStatus: async () => current,
    uplinkRegister: async (request) => { calls.push('uplinkRegister'); registers.push(request); return registered },
    uplinkLink: async (address) => { calls.push('uplinkLink'); links.push(address ?? null); return PERSONAL },
    uplinkUnlink: async () => { calls.push('uplinkUnlink'); return current },
    hostOrganizations: async () => { throw new Error('not asked in these tests') },
    hostSelfTest: async () => { throw new Error('not asked in these tests') },
  }
  return { api, calls, registers, links }
}

/** The account plane with the device grant, the account read, and the ticket endpoint. */
function accountPlane() {
  const plane = fakeAccountPlane({ clientId: 'solus-cli' })
  const tickets: unknown[] = []
  let polls = 0
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.pathname === '/api/auth/device/code') {
      return Response.json({ device_code: 'dc', user_code: 'BCDFGHJK', verification_uri: `${ISSUER}/device`, verification_uri_complete: `${ISSUER}/device?user_code=BCDFGHJK`, expires_in: 900, interval: 5 })
    }
    if (url.pathname === '/v1/account') {
      return Response.json({ userId: 'user-1', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [{ organizationId: 'org_b', name: 'Beta', role: 'owner', mayCreateManagedHost: false, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: true } }] })
    }
    if (url.pathname === '/v1/enrollment-tickets') {
      const body = JSON.parse(String(init?.body)) as { organizationId?: string }
      tickets.push(body)
      // The control plane names the kind in the ticket it issues.
      return Response.json({ ticket: body.organizationId ? 'org_ISSUED' : 'set_ISSUED', expiresAt: 1 })
    }
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
      return ++polls === 1 ? Response.json({ error: 'authorization_pending' }, { status: 400 }) : Response.json(plane.deviceTokens())
    }
    return plane.fetch(input, init)
  }
  return { plane, tickets, fetch: fetchImpl as typeof fetch }
}

function harness(server: ReturnType<typeof fakeServer>, fetchImpl: typeof fetch, choice: ConnectChoice = { kind: 'personal' }) {
  const installs: string[] = []
  const deps: ConnectDeps = {
    localHost: (_dataDir, run) => run(server.api),
    installCloudflared: async (dir) => { installs.push(dir) },
    fetch: fetchImpl,
    sleep: async () => {},
  }
  const reporter: ConnectReporter = { deviceCode: () => {}, stage: () => {}, choose: async () => choice }
  return { deps, reporter, installs }
}

const noNetwork = (async () => { throw new Error('no request is expected') }) as unknown as typeof fetch

function cloudStatus(link: UplinkStatus['link']): UplinkStatus {
  return { registration: { registered: true, registration: { ...REGISTRATION, organizationId: 'org_b' }, owner: null }, link }
}

describe('solus connect with a code: the code decides the kind, the address decides the reach', () => {
  test('an organization code with an address registers with the address, installs no cloudflared, and makes no later call', async () => {
    // WHY: the link did not finish here, and still no `uplinkLink` follows: the server
    // is a cloud machine after `uplinkRegister` and refuses the local socket.
    const server = fakeServer(UNREGISTERED, cloudStatus({ linked: false, error: 'Solus cloud is not reachable' }))
    const { deps, reporter, installs } = harness(server, noNetwork)
    const answer = await connectHost({ dataDir, noOpen: true, code: 'org_ORG@app.solus.sh', address: ADDRESS }, reporter, deps)
    expect(server.registers).toEqual([{ ticket: 'org_ORG', directoryUrl: 'https://app.solus.sh', address: ADDRESS }])
    expect(server.calls).toEqual(['uplinkRegister'])
    expect(installs).toEqual([])
    expect(answer.link).toEqual({ linked: false, error: 'Solus cloud is not reachable' })
  })

  test('an organization code with no address gets a tunnel: cloudflared is installed first, no address is sent, and no later call is made', async () => {
    // WHY: the address is optional for a cloud machine too. The kind comes from the code, not from `--address`.
    const server = fakeServer(UNREGISTERED, cloudStatus({ linked: false, error: 'Solus cloud is not reachable' }))
    const { deps, reporter, installs } = harness(server, noNetwork)
    await connectHost({ dataDir, noOpen: true, code: 'org_ORG@app.solus.sh' }, reporter, deps)
    expect(server.registers).toEqual([{ ticket: 'org_ORG', directoryUrl: 'https://app.solus.sh' }])
    expect(server.calls).toEqual(['uplinkRegister'])
    expect(installs).toEqual([dataDir])
  })

  test('a personal code with no address gets a tunnel: cloudflared is installed, and a link that did not finish is turned on', async () => {
    const server = fakeServer(UNREGISTERED, UNLINKED)
    const { deps, reporter, installs } = harness(server, noNetwork)
    await connectHost({ dataDir, noOpen: true, code: 'set_ME@app.solus.sh' }, reporter, deps)
    expect(server.registers).toEqual([{ ticket: 'set_ME', directoryUrl: 'https://app.solus.sh' }])
    expect(server.calls).toEqual(['uplinkRegister', 'uplinkLink'])
    expect(installs).toEqual([dataDir])
  })

  test('a personal code with an address stays personal: the address goes with the ticket, and no cloudflared is installed', async () => {
    // WHY: an address made a cloud host before. Now a person's own machine can be reached at its address too.
    const server = fakeServer(UNREGISTERED, UNLINKED)
    const { deps, reporter, installs } = harness(server, noNetwork)
    await connectHost({ dataDir, noOpen: true, code: 'set_ME@app.solus.sh', address: ADDRESS }, reporter, deps)
    expect(server.registers).toEqual([{ ticket: 'set_ME', directoryUrl: 'https://app.solus.sh', address: ADDRESS }])
    // The link that did not finish is asked for again; Solus cloud has the address from the registration.
    expect(server.calls).toEqual(['uplinkRegister', 'uplinkLink'])
    expect(server.links).toEqual([null])
    expect(installs).toEqual([])
  })

  test('a registered server cannot become a cloud machine: an organization code is refused before any call, with the way out', async () => {
    const server = fakeServer(PERSONAL, PERSONAL)
    const { deps, reporter, installs } = harness(server, noNetwork)
    await expect(connectHost({ dataDir, noOpen: true, code: 'org_ORG@app.solus.sh', address: ADDRESS }, reporter, deps)).rejects.toThrow(/registered to a Solus account already.*--data-dir/)
    await expect(connectHost({ dataDir, noOpen: true, code: 'org_ORG@app.solus.sh' }, reporter, deps)).rejects.toThrow(/--data-dir/)
    // A bare ticket has the same kind as the code that carries it.
    await expect(connectHost({ dataDir, cloudUrl: ISSUER, noOpen: true, code: 'org_ORG' }, reporter, deps)).rejects.toThrow(/--data-dir/)
    expect(server.calls).toEqual([])
    expect(installs).toEqual([])
  })
})

describe('solus connect --address on a registered personal server', () => {
  test('sets the address with one link call: no sign-in, no ticket, no cloudflared', async () => {
    // WHY: the registration of the server asks for its new reach. `noNetwork` fails the test if the CLI signs in.
    const server = fakeServer(PERSONAL, PERSONAL)
    const { deps, reporter, installs } = harness(server, noNetwork)
    await connectHost({ dataDir, noOpen: true, address: ADDRESS }, reporter, deps)
    expect(server.calls).toEqual(['uplinkLink'])
    expect(server.links).toEqual([ADDRESS])
    expect(installs).toEqual([])
  })

  test('a personal code changes nothing about that: the server keeps its registration, and only the address is set', async () => {
    const server = fakeServer(UNLINKED, UNLINKED)
    const { deps, reporter } = harness(server, noNetwork)
    await connectHost({ dataDir, noOpen: true, code: 'set_ME@app.solus.sh', address: ADDRESS }, reporter, deps)
    expect(server.calls).toEqual(['uplinkLink'])
    expect(server.links).toEqual([ADDRESS])
  })

  test('with no address, a registered server that is not linked gets its tunnel again', async () => {
    const server = fakeServer(UNLINKED, UNLINKED)
    const account = accountPlane()
    const { deps, reporter, installs } = harness(server, account.fetch, { kind: 'personal' })
    await connectHost({ dataDir, noOpen: true }, reporter, deps)
    expect(server.calls).toEqual(['uplinkLink'])
    expect(server.links).toEqual([null])
    expect(installs).toEqual([dataDir])
    expect(account.tickets).toEqual([])
  })
})

describe('solus connect with a sign-in: the choice decides the kind', () => {
  test('an organization choice with an address issues a ticket for that one organization and registers with the address', async () => {
    const server = fakeServer(UNREGISTERED, cloudStatus({ linked: true, tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 }, state: { observed: 'online' } }))
    const account = accountPlane()
    const { deps, reporter, installs } = harness(server, account.fetch, { kind: 'organization', organizationId: 'org_b' })
    await connectHost({ dataDir, cloudUrl: ISSUER, noOpen: true, address: ADDRESS }, reporter, deps)
    expect(account.tickets).toEqual([{ organizationId: 'org_b' }])
    expect(server.registers).toEqual([{ ticket: 'org_ISSUED', directoryUrl: ISSUER, address: ADDRESS }])
    expect(server.calls).toEqual(['uplinkRegister'])
    expect(installs).toEqual([])
  })

  test('an organization choice with no address gets a tunnel: cloudflared, a ticket for that organization, and one call', async () => {
    // WHY: this choice stopped with "needs its own HTTPS address" before. The address is optional now.
    const server = fakeServer(UNREGISTERED, cloudStatus({ linked: false }))
    const account = accountPlane()
    const { deps, reporter, installs } = harness(server, account.fetch, { kind: 'organization', organizationId: 'org_b' })
    await connectHost({ dataDir, cloudUrl: ISSUER, noOpen: true }, reporter, deps)
    expect(account.tickets).toEqual([{ organizationId: 'org_b' }])
    expect(server.registers).toEqual([{ ticket: 'org_ISSUED', directoryUrl: ISSUER }])
    expect(server.calls).toEqual(['uplinkRegister'])
    expect(installs).toEqual([dataDir])
    // The sign-in of the command ends with it.
    expect(account.plane.liveTokens()).toEqual([])
  })

  test('a personal choice with an address registers a personal server at that address, with no cloudflared', async () => {
    const server = fakeServer(UNREGISTERED, PERSONAL)
    const account = accountPlane()
    const { deps, reporter, installs } = harness(server, account.fetch, { kind: 'personal' })
    await connectHost({ dataDir, cloudUrl: ISSUER, noOpen: true, address: ADDRESS }, reporter, deps)
    expect(account.tickets).toEqual([{}])
    expect(server.registers).toEqual([{ ticket: 'set_ISSUED', directoryUrl: ISSUER, address: ADDRESS }])
    expect(server.calls).toEqual(['uplinkRegister'])
    expect(installs).toEqual([])
  })

  test('an organization choice on a registered server is refused before a ticket is issued, and the sign-in ends', async () => {
    const server = fakeServer(UNLINKED, UNLINKED)
    const account = accountPlane()
    const { deps, reporter, installs } = harness(server, account.fetch, { kind: 'organization', organizationId: 'org_b' })
    await expect(connectHost({ dataDir, noOpen: true }, reporter, deps)).rejects.toThrow(/registered to a Solus account already.*--data-dir/)
    expect(account.tickets).toEqual([])
    expect(server.calls).toEqual([])
    expect(installs).toEqual([])
    expect(account.plane.liveTokens()).toEqual([])
  })
})

describe('the machine address', () => {
  test('is an HTTPS origin, normalized', () => {
    expect(parseMachineAddress('https://machine.example.com')).toBe('https://machine.example.com')
    expect(parseMachineAddress(' https://Machine.Example.com:8443/ ')).toBe('https://machine.example.com:8443')
  })

  test('is http only on loopback, for development', () => {
    expect(parseMachineAddress('http://127.0.0.1:34118')).toBe('http://127.0.0.1:34118')
    expect(parseMachineAddress('http://localhost:34118')).toBe('http://localhost:34118')
    expect(() => parseMachineAddress('http://machine.example.com')).toThrow(/must use HTTPS/)
  })

  test('names the machine and nothing else: no path, query, or credentials', () => {
    expect(() => parseMachineAddress('https://machine.example.com/solus')).toThrow(/path or a query/)
    expect(() => parseMachineAddress('https://machine.example.com?x=1')).toThrow(/path or a query/)
    expect(() => parseMachineAddress('https://user:secret@machine.example.com')).toThrow(/user name or a password/)
    expect(() => parseMachineAddress('machine.example.com')).toThrow(/is not an address/)
  })
})

describe('a cloud machine from the command line', () => {
  const writeRecords = (registration: object, link?: object) => {
    writeFileSync(join(dataDir, 'host-registration.json'), JSON.stringify({ version: 1, registration }))
    if (link) writeFileSync(join(dataDir, 'host-link.json'), JSON.stringify({ version: 2, ...link }))
  }

  test('status comes from the records in the data directory, with no call to the server', () => {
    writeRecords({ ...REGISTRATION, organizationId: 'org_b' }, { hostId: 'h1', desired: 'linked', tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 }, reach: 'direct' })
    const record = readCloudMachineRecord(dataDir)
    expect(record).toEqual({ registration: { ...REGISTRATION, organizationId: 'org_b' }, tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 }, reach: 'direct' })
    expect(describeCloudMachine(record!)).toEqual([
      'Solus: cloud host of organization org_b',
      '  Server: h1 (Cloud host)',
      `  Control plane: ${ISSUER}`,
      '  Solus API: https://api.test',
      '  Address: https://machine.example.com (it must forward to port 34118 on this machine)',
      '  Members of the organization reach this server through Solus. It has no pairing code.',
      '  Live status is not available from the command line: a cloud host trusts no local connection. See the machine in the Solus console.',
    ])
  })

  test('a cloud machine with a tunnel shows the host name of the tunnel, not an address to forward', () => {
    // The server writes `reach` for a tunnel, and a record with none is a tunnel too.
    for (const reach of [{ reach: 'tunnel' }, {}]) {
      writeRecords({ ...REGISTRATION, organizationId: 'org_b' }, { hostId: 'h1', desired: 'linked', tunnel: { hostname: 'h-h1.solus.sh', proxiedPort: 34118 }, ...reach })
      const text = describeCloudMachine(readCloudMachineRecord(dataDir)!).join('\n')
      expect(text).toContain('  Tunnel: h-h1.solus.sh\n')
      expect(text).not.toContain('Address:')
    }
  })

  test('the address of a machine with managed compute needs no forwarding by its operator', () => {
    writeRecords({ ...REGISTRATION, organizationId: 'org_b', hasManagedCompute: true }, { hostId: 'h1', desired: 'linked', tunnel: { hostname: 'vm.provider.example', proxiedPort: 34118 }, reach: 'direct' })
    expect(describeCloudMachine(readCloudMachineRecord(dataDir)!)).toContain('  Address: https://vm.provider.example')
  })

  test('a link Solus cloud did not make yet is said, not invented; a link of another registration is not this machine\'s', () => {
    writeRecords({ ...REGISTRATION, organizationId: 'org_b' }, { hostId: 'h-old', desired: 'linked', tunnel: { hostname: 'old.example.com', proxiedPort: 34118 }, reach: 'direct' })
    const record = readCloudMachineRecord(dataDir)
    expect(record?.tunnel).toBeNull()
    expect(describeCloudMachine(record!).join('\n')).toContain('Reachable from the internet: not yet. Restart the server so that it asks Solus cloud again.')
  })

  test('a personal server shows its reach too: the link record says which way, because the live status does not', () => {
    const live = { uplink: PERSONAL, standing: { registered: true, hostId: 'h1', kind: 'personal' as const, owner: null, organizations: [], insightsOptIn: [], apiUrl: null, delivery: [], deliveryError: null } }
    writeRecords(REGISTRATION, { hostId: 'h1', desired: 'linked', tunnel: PERSONAL.link.linked ? PERSONAL.link.tunnel : null })
    expect(readLinkReach(dataDir)).toBe('tunnel')
    expect(describeConnection({ ...live, reach: readLinkReach(dataDir) })).toContain('  Tunnel: h-h1.solus.sh — online')
    writeRecords(REGISTRATION, { hostId: 'h1', desired: 'linked', tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 }, reach: 'direct' })
    expect(readLinkReach(dataDir)).toBe('direct')
    const direct: UplinkStatus = { ...PERSONAL, link: { linked: true, tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 }, state: { observed: 'online' } } }
    expect(describeConnection({ ...live, uplink: direct, reach: readLinkReach(dataDir) })).toContain('  Address: https://machine.example.com (it must forward to port 34118 on this machine) — online')
  })

  test('only a registration that names an organization is a cloud machine', () => {
    expect(readCloudMachineRecord(dataDir)).toBeNull()
    writeRecords(REGISTRATION, { hostId: 'h1', desired: 'linked', tunnel: { hostname: 'h-h1.solus.sh', proxiedPort: 34118 } })
    expect(readCloudMachineRecord(dataDir)).toBeNull()
    writeFileSync(join(dataDir, 'host-registration.json'), '{ not json')
    expect(readCloudMachineRecord(dataDir)).toBeNull()
  })

  test('unlink and connect say who changes a cloud machine, and do not dial the socket that refuses them', async () => {
    writeRecords({ ...REGISTRATION, organizationId: 'org_b' })
    // WHY: no server runs in this data directory; a dial would fail with "not running".
    await expect(disconnectHost(dataDir)).rejects.toThrow('An organization owner removes the machine in the Solus console.')
    const server = fakeServer(UNREGISTERED, UNREGISTERED)
    const { deps, reporter } = harness(server, noNetwork)
    await expect(connectHost({ dataDir, noOpen: true, code: 'org_OTHER@app.solus.sh', address: ADDRESS }, reporter, deps)).rejects.toThrow(/cloud host of an organization already/)
    expect(server.calls).toEqual([])
  })
})
