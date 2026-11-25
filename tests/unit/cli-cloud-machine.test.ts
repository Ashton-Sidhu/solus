import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { HostRegistrationRequest, UplinkStatus } from '@solus/contracts/uplink'
import { parseMachineAddress, readCloudMachineRecord } from '../../apps/cli/src/lib/cloud-machine'
import { connectHost, disconnectHost, type ConnectChoice, type ConnectDeps, type ConnectReporter, type LocalHostApi } from '../../apps/cli/src/lib/connect'
import { describeCloudMachine } from '../../apps/cli/src/lib/onboarding'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// plans/034-one-cloud-machine-kind.md: a server becomes a cloud machine of one
// organization when it registers with an organization ticket and its own HTTPS
// address. It has no tunnel, so the CLI installs no cloudflared for it. The server
// enrolls and records the address inside the one `uplinkRegister` call, and after that
// call it refuses its local socket: the CLI makes no later call, and reads what it
// says about the machine from the records in the data directory.

const REGISTRATION = { hostId: 'h1', issuer: ISSUER, jwksUrl: `${ISSUER}/api/auth/jwks`, directoryUrl: ISSUER, generation: 1, apiUrl: 'https://api.test' }
const UNREGISTERED: UplinkStatus = { registration: { registered: false }, link: { linked: false } }
const PERSONAL: UplinkStatus = {
  registration: { registered: true, registration: REGISTRATION, owner: { userId: 'user-1', email: 'ada@example.test' } },
  link: { linked: true, tunnel: { hostname: 'h-h1.solus.sh', proxiedPort: 34118 }, state: { observed: 'online' } },
}
const ADDRESS = 'https://machine.example.com'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'solus-cli-cloud-machine-')) })
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })

/** A server's local socket: answers `current`, and records every call that changes it. */
function fakeServer(current: UplinkStatus, registered: UplinkStatus) {
  const calls: string[] = []
  const registers: HostRegistrationRequest[] = []
  const api: LocalHostApi = {
    uplinkStatus: async () => current,
    uplinkRegister: async (request) => { calls.push('uplinkRegister'); registers.push(request); return registered },
    uplinkLink: async () => { calls.push('uplinkLink'); return PERSONAL },
    uplinkUnlink: async () => { calls.push('uplinkUnlink'); return current },
    hostOrganizations: async () => { throw new Error('not asked in these tests') },
    hostSelfTest: async () => { throw new Error('not asked in these tests') },
  }
  return { api, calls, registers }
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
      tickets.push(JSON.parse(String(init?.body)))
      return Response.json({ ticket: 'set_ISSUED', expiresAt: 1 })
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

describe('solus connect with --address', () => {
  test('an organization code registers with the address, installs no cloudflared, and makes no later call', async () => {
    // WHY: the link did not finish here, and still no `uplinkLink` follows: the server
    // is a cloud machine after `uplinkRegister` and refuses the local socket.
    const server = fakeServer(UNREGISTERED, cloudStatus({ linked: false, error: 'Solus cloud is not reachable' }))
    const { deps, reporter, installs } = harness(server, noNetwork)
    const answer = await connectHost({ dataDir, noOpen: true, code: 'set_ORG@app.solus.sh', address: ADDRESS }, reporter, deps)
    expect(server.registers).toEqual([{ ticket: 'set_ORG', directoryUrl: 'https://app.solus.sh', address: ADDRESS }])
    expect(server.calls).toEqual(['uplinkRegister'])
    expect(installs).toEqual([])
    expect(answer.link).toEqual({ linked: false, error: 'Solus cloud is not reachable' })
  })

  test('a personal code takes no address: cloudflared is installed, and the tunnel is turned on', async () => {
    const server = fakeServer(UNREGISTERED, { ...PERSONAL, link: { linked: false } })
    const { deps, reporter, installs } = harness(server, noNetwork)
    await connectHost({ dataDir, noOpen: true, code: 'set_ME@app.solus.sh' }, reporter, deps)
    expect(server.registers).toEqual([{ ticket: 'set_ME', directoryUrl: 'https://app.solus.sh' }])
    expect(server.calls).toEqual(['uplinkRegister', 'uplinkLink'])
    expect(installs).toEqual([dataDir])
  })

  test('an organization choice without an address stops before a ticket is issued, and names the command to run', async () => {
    const server = fakeServer(UNREGISTERED, cloudStatus({ linked: false }))
    const account = accountPlane()
    const { deps, reporter, installs } = harness(server, account.fetch, { kind: 'organization', organizationId: 'org_b' })
    await expect(connectHost({ dataDir, cloudUrl: ISSUER, noOpen: true }, reporter, deps)).rejects.toThrow('solus connect --address https://machine.example.com')
    expect(account.tickets).toEqual([])
    expect(server.calls).toEqual([])
    expect(installs).toEqual([])
    // The sign-in of the command ends with it, also when the command stops.
    expect(account.plane.liveTokens()).toEqual([])
  })

  test('an organization choice with an address issues a ticket for that one organization and registers with the address', async () => {
    const server = fakeServer(UNREGISTERED, cloudStatus({ linked: true, tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 }, state: { observed: 'online' } }))
    const account = accountPlane()
    const { deps, reporter, installs } = harness(server, account.fetch, { kind: 'organization', organizationId: 'org_b' })
    await connectHost({ dataDir, cloudUrl: ISSUER, noOpen: true, address: ADDRESS }, reporter, deps)
    expect(account.tickets).toEqual([{ organizationId: 'org_b' }])
    expect(server.registers).toEqual([{ ticket: 'set_ISSUED', directoryUrl: ISSUER, address: ADDRESS }])
    expect(server.calls).toEqual(['uplinkRegister'])
    expect(installs).toEqual([])
  })

  test('an address with a personal choice is refused: a personal link has a tunnel, not an address', async () => {
    const server = fakeServer(UNREGISTERED, PERSONAL)
    const account = accountPlane()
    const { deps, reporter } = harness(server, account.fetch, { kind: 'personal' })
    await expect(connectHost({ dataDir, cloudUrl: ISSUER, noOpen: true, address: ADDRESS }, reporter, deps)).rejects.toThrow(/personal link takes no address/)
    expect(account.tickets).toEqual([])
    expect(server.calls).toEqual([])
  })

  test('a registered server cannot become a cloud machine: it is refused before any sign-in or ticket, with the way out', async () => {
    const server = fakeServer(PERSONAL, PERSONAL)
    const { deps, reporter } = harness(server, noNetwork)
    await expect(connectHost({ dataDir, noOpen: true, code: 'set_ORG@app.solus.sh', address: ADDRESS }, reporter, deps)).rejects.toThrow(/registered to a Solus account already.*--data-dir/)
    await expect(connectHost({ dataDir, noOpen: true, address: ADDRESS }, reporter, deps)).rejects.toThrow(/--data-dir/)
    expect(server.calls).toEqual([])
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
    writeRecords({ ...REGISTRATION, organizationId: 'org_b' }, { hostId: 'h1', desired: 'linked', tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 } })
    const record = readCloudMachineRecord(dataDir)
    expect(record).toEqual({ registration: { ...REGISTRATION, organizationId: 'org_b' }, tunnel: { hostname: 'machine.example.com', proxiedPort: 34118 } })
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

  test('an address Solus cloud did not record yet is said, not invented; a link of another registration is not this machine\'s', () => {
    writeRecords({ ...REGISTRATION, organizationId: 'org_b' }, { hostId: 'h-old', desired: 'linked', tunnel: { hostname: 'old.example.com', proxiedPort: 34118 } })
    const record = readCloudMachineRecord(dataDir)
    expect(record?.tunnel).toBeNull()
    expect(describeCloudMachine(record!).join('\n')).toContain('Address: Solus cloud did not record it yet. Restart the server so that it asks again.')
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
    await expect(connectHost({ dataDir, noOpen: true, code: 'set_OTHER@app.solus.sh', address: ADDRESS }, reporter, deps)).rejects.toThrow(/cloud host of an organization already/)
    expect(server.calls).toEqual([])
  })
})
