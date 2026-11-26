import { describe, expect, test } from 'bun:test'
import type { HostSelfTest } from '@solus/contracts/host-connection'
import type { UplinkStatus } from '@solus/contracts/uplink'
import {
  gateAddressKind,
  registerWay,
  resolveOutsideAppGate,
  turnOnWay,
  type OutsideAppGateInput,
} from '@solus/workspace-ui/components/connections/lib/outside-apps-gate'

// The gate before the steps of "Use Solus in other apps" (after T3 Code's
// resolveMcpGate). What a person would notice going wrong: a cloud app sent a
// public address that does not answer, an app on their own computer blocked by
// a tunnel it does not need, a dialog that spins forever, and a "Turn on"
// button on a client that the host refuses.

const LOCAL_ONLY = { localUrl: 'http://localhost:4810/mcp', publicUrl: null }
const WITH_TUNNEL = { localUrl: 'http://localhost:4810/mcp', publicUrl: 'https://h-1.solus.dev/mcp' }

const REGISTRATION: UplinkStatus['registration'] = {
  registered: true,
  registration: { hostId: 'h1', issuer: 'https://app.solus.sh', jwksUrl: 'https://app.solus.sh/jwks', directoryUrl: 'https://app.solus.sh', generation: 1 },
  owner: null,
}
const NOT_REGISTERED: UplinkStatus = { registration: { registered: false }, link: { linked: false } }
const UNLINKED: UplinkStatus = { registration: REGISTRATION, link: { linked: false } }
const linked = (observed: 'online' | 'offline' | 'error', error?: string): UplinkStatus => ({
  registration: REGISTRATION,
  link: { linked: true, tunnel: { hostname: 'h-1.solus.dev', proxiedPort: 4810 }, state: error ? { observed, error } : { observed } },
})

function test_(reachable: boolean | null, problem: HostSelfTest['problem'] = null): { kind: 'done'; test: HostSelfTest } {
  return { kind: 'done', test: { checkedAt: 1, reachable, summary: reachable ? 'Reachable.' : 'Not reachable.', stages: [], problem, facts: [] } }
}

function gate(overrides: Partial<OutsideAppGateInput>) {
  return resolveOutsideAppGate({
    addressKind: 'public',
    endpoint: WITH_TUNNEL,
    endpointError: null,
    uplink: linked('online'),
    uplinkError: null,
    selfTest: test_(true),
    turningOn: false,
    ...overrides,
  })
}

describe('an app that needs the public address', () => {
  test('opens on the public address once the host tested it', () => {
    expect(gate({})).toEqual({ kind: 'open', mcpUrl: 'https://h-1.solus.dev/mcp' })
  })

  test('waits for the host test, and asks for one when none ran', () => {
    expect(gate({ selfTest: undefined })).toEqual({ kind: 'checking', needsSelfTest: true })
    expect(gate({ selfTest: { kind: 'running' } })).toEqual({ kind: 'checking', needsSelfTest: false })
  })

  test('a failed test shows the reason and the fix', () => {
    const problem = { stage: 'tunnel' as const, cause: 'connector-stopped' as const, reason: 'The tunnel connector stopped.', fix: 'Restart Solus.', hint: null }
    expect(gate({ selfTest: test_(false, problem) })).toEqual({ kind: 'offline', where: 'public-address', reason: 'The tunnel connector stopped.', fix: 'Restart Solus.' })
    expect(gate({ selfTest: { kind: 'error', message: 'timeout' } })).toMatchObject({ kind: 'offline', reason: 'The connection test could not run: timeout' })
  })

  test('a host that does not answer is offline, not checking forever', () => {
    expect(gate({ endpoint: null, endpointError: 'Host is offline' })).toEqual({ kind: 'offline', where: 'host', reason: 'Host is offline', fix: null })
    expect(gate({ endpoint: LOCAL_ONLY, uplink: undefined, uplinkError: 'socket closed' })).toMatchObject({ kind: 'offline', where: 'host' })
  })

  test('checks until the address and the link are read', () => {
    expect(gate({ endpoint: null })).toMatchObject({ kind: 'checking' })
    expect(gate({ endpoint: LOCAL_ONLY, uplink: undefined })).toMatchObject({ kind: 'checking' })
  })

  test('a host with no Solus account must be registered first', () => {
    expect(gate({ endpoint: LOCAL_ONLY, uplink: NOT_REGISTERED })).toEqual({ kind: 'not-registered' })
  })

  test('a registered host with the tunnel off asks to turn it on, and says why a link stopped', () => {
    expect(gate({ endpoint: LOCAL_ONLY, uplink: UNLINKED })).toEqual({ kind: 'turn-on', turningOn: false, error: null })
    expect(gate({ endpoint: LOCAL_ONLY, uplink: { registration: REGISTRATION, link: { linked: false, error: 'Rejected' } } })).toMatchObject({ error: 'Rejected' })
  })

  test('while the tunnel starts it keeps showing Turning on, then the down tunnel says why', () => {
    expect(gate({ endpoint: LOCAL_ONLY, uplink: UNLINKED, turningOn: true })).toMatchObject({ kind: 'turn-on', turningOn: true })
    expect(gate({ endpoint: LOCAL_ONLY, uplink: linked('offline'), turningOn: true })).toMatchObject({ kind: 'turn-on', turningOn: true })
    expect(gate({ endpoint: LOCAL_ONLY, uplink: linked('error', 'Port 4810 is in use') })).toEqual({ kind: 'offline', where: 'public-address', reason: 'Port 4810 is in use', fix: null })
  })

  test('a cloud machine, linked at its own address, goes through the same test', () => {
    expect(gate({ uplink: linked('online'), selfTest: undefined })).toMatchObject({ kind: 'checking', needsSelfTest: true })
  })
})

describe('an app on the host computer', () => {
  test('skips every public-address gate and gets the local address', () => {
    for (const uplink of [NOT_REGISTERED, UNLINKED, linked('error', 'down'), undefined]) {
      expect(gate({ addressKind: 'local', endpoint: LOCAL_ONLY, uplink, selfTest: undefined })).toEqual({ kind: 'open', mcpUrl: 'http://localhost:4810/mcp' })
    }
  })

  test('Something else gets the public address when the host has one, else the local one, with no test', () => {
    expect(gate({ addressKind: 'public-or-local', selfTest: undefined })).toEqual({ kind: 'open', mcpUrl: 'https://h-1.solus.dev/mcp' })
    expect(gate({ addressKind: 'public-or-local', endpoint: LOCAL_ONLY, uplink: UNLINKED })).toEqual({ kind: 'open', mcpUrl: 'http://localhost:4810/mcp' })
  })

  test('still waits for the host to answer', () => {
    expect(gate({ addressKind: 'local', endpoint: null })).toMatchObject({ kind: 'checking' })
  })
})

describe('which address the gate checks', () => {
  const cloud = { needsPublicUrl: true }
  const onComputer = { needsPublicUrl: false }

  test('on the host computer, the App step is open; a cloud app meets the gate only after it is chosen', () => {
    expect(gateAddressKind(undefined, true)).toBe('local')
    expect(gateAddressKind(cloud, true)).toBe('public')
    expect(gateAddressKind(onComputer, true)).toBe('local')
    expect(gateAddressKind(null, true)).toBe('public-or-local')
  })

  test('on another computer, every app needs the public address, so the gate comes before the steps', () => {
    expect(gateAddressKind(undefined, false)).toBe('public')
    expect(gateAddressKind(onComputer, false)).toBe('public')
    expect(gateAddressKind(null, false)).toBe('public')
  })
})

describe('where the public address is turned on', () => {
  const base = { hostKind: 'personal' as const, control: 'manage' as const, mayReachLocally: true, locked: false }

  test('only a local owner turns it on here, as uplinkLink needs host.local.reach', () => {
    expect(turnOnWay(base)).toBe('here')
    expect(turnOnWay({ ...base, mayReachLocally: false })).toBe('elsewhere')
    expect(turnOnWay({ ...base, control: 'view' })).toBe('elsewhere')
    expect(turnOnWay({ ...base, control: 'none' })).toBe('elsewhere')
  })

  test('a policy that keeps the tunnel off says so instead of a button', () => {
    expect(turnOnWay({ ...base, locked: true })).toBe('policy')
  })

  test('a cloud machine gets its address from Solus Cloud', () => {
    expect(turnOnWay({ ...base, hostKind: 'cloud', control: 'none' })).toBe('cloud')
  })
})

describe('how the host is registered', () => {
  test('as the Solus Cloud section does: register with the account, sign in first, or from elsewhere', () => {
    expect(registerWay({ control: 'manage', accountAvailable: true, canLink: true })).toBe('register')
    expect(registerWay({ control: 'manage', accountAvailable: true, canLink: false })).toBe('sign-in')
    expect(registerWay({ control: 'manage', accountAvailable: false, canLink: false })).toBe('elsewhere')
    expect(registerWay({ control: 'view', accountAvailable: true, canLink: true })).toBe('elsewhere')
  })
})
