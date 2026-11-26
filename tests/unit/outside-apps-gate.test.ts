import { describe, expect, test } from 'bun:test'
import type { AppAddress } from '@solus/contracts/host-api'
import type { UplinkStatus } from '@solus/contracts/uplink'
import type { AppAddressTests, AppEndpoint } from '@solus/workspace-ui/contexts/connections/connections.store.svelte'
import {
  registerWay,
  resolveOutsideAppGate,
  solusCard,
  turnOnWay,
  type OutsideAppGateInput,
} from '@solus/workspace-ui/components/connections/lib/outside-apps-gate'

// The gate of an open row of "Use Solus from your other apps" (after T3 Code's
// resolveMcpGate; plans/035 §0.8). What a person would notice going wrong: a
// cloud app sent a tailnet address it cannot reach, or an address that does not
// answer; a host with Tailscale or its own address stopped because it has no
// Solus account; an app on their own computer blocked by an address it does not
// need; a dialog that spins forever; and a hairpin failure that blocks an app
// that could reach the host.

const LOCAL = 'http://localhost:4810/mcp'
const SOLUS: AppAddress = { source: 'solus', url: 'https://h-1.solus.dev/mcp', reach: 'internet' }
const FUNNEL: AppAddress = { source: 'tailscale-funnel', url: 'https://box.tail1.ts.net/mcp', reach: 'internet' }
const SERVE: AppAddress = { source: 'tailscale-serve', url: 'https://box.tail1.ts.net/mcp', reach: 'tailnet' }
const CUSTOM: AppAddress = { source: 'custom', url: 'https://solus.example.com/mcp', reach: 'internet' }
const endpointWith = (...addresses: AppAddress[]): AppEndpoint => ({ localUrl: LOCAL, publicUrl: addresses.find((a) => a.reach === 'internet')?.url ?? null, addresses })
const LOCAL_ONLY = endpointWith()
const WITH_TUNNEL = endpointWith(SOLUS)

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

const passed = (address: AppAddress): AppAddressTests => ({ [address.source]: { kind: 'done', url: address.url, reachable: true, reason: null, checkedAt: 1 } })
const failed = (address: AppAddress, reason: string | null): AppAddressTests => ({ [address.source]: { kind: 'done', url: address.url, reachable: false, reason, checkedAt: 1 } })

function gate(overrides: Partial<OutsideAppGateInput>) {
  return resolveOutsideAppGate({
    addressKind: 'internet',
    endpoint: WITH_TUNNEL,
    endpointError: null,
    uplink: linked('online'),
    uplinkError: null,
    addressTests: passed(SOLUS),
    acceptedUrl: null,
    turningOn: false,
    ...overrides,
  })
}

describe('a cloud app, which needs an internet address', () => {
  test('opens on the Solus address once the host tested it, and names its source', () => {
    expect(gate({})).toEqual({ kind: 'open', mcpUrl: SOLUS.url, address: SOLUS, warning: null })
  })

  test('waits for the test of the chosen address, and asks for one when none ran for its current url', () => {
    expect(gate({ addressTests: {} })).toEqual({ kind: 'checking', testSource: 'solus' })
    expect(gate({ addressTests: { solus: { kind: 'running', url: SOLUS.url } } })).toEqual({ kind: 'checking', testSource: null })
    // A test of an older address (the person changed their own address) proves nothing.
    expect(gate({ endpoint: endpointWith(CUSTOM), uplink: NOT_REGISTERED, addressTests: { custom: { kind: 'done', url: 'https://old.example.com/mcp', reachable: true, reason: null, checkedAt: 1 } } }))
      .toEqual({ kind: 'checking', testSource: 'custom' })
  })

  test('a failed test shows the reason, and the person checks again', () => {
    expect(gate({ addressTests: failed(SOLUS, 'The tunnel connector stopped.') })).toEqual({ kind: 'offline', where: 'address', address: SOLUS, reason: 'The tunnel connector stopped.', canGoOn: false })
    expect(gate({ addressTests: { solus: { kind: 'error', url: SOLUS.url, message: 'timeout' } } })).toMatchObject({ kind: 'offline', reason: 'The address test could not run: timeout', canGoOn: false })
    expect(gate({ addressTests: failed(SOLUS, null) })).toMatchObject({ reason: 'The address does not answer.' })
  })

  test('a hairpin failure lets the person go on, with a warning, only for the address they accepted', () => {
    const hairpin = failed(FUNNEL, 'The host cannot reach its own address (hairpin NAT).')
    const input = { endpoint: endpointWith(FUNNEL), uplink: NOT_REGISTERED, addressTests: hairpin }
    expect(gate(input)).toMatchObject({ kind: 'offline', canGoOn: true })
    expect(gate({ ...input, acceptedUrl: FUNNEL.url })).toEqual({ kind: 'open', mcpUrl: FUNNEL.url, address: FUNNEL, warning: 'The host cannot reach its own address (hairpin NAT).' })
    expect(gate({ ...input, acceptedUrl: 'https://other.example/mcp' })).toMatchObject({ kind: 'offline' })
  })

  test('a host with no Solus account opens on Tailscale Funnel or its own address', () => {
    expect(gate({ endpoint: endpointWith(FUNNEL), uplink: NOT_REGISTERED, addressTests: passed(FUNNEL) })).toMatchObject({ kind: 'open', address: FUNNEL })
    expect(gate({ endpoint: endpointWith(CUSTOM), uplink: undefined, addressTests: passed(CUSTOM) })).toMatchObject({ kind: 'open', address: CUSTOM })
  })

  test('prefers Solus, then Funnel, then the own address', () => {
    expect(gate({ endpoint: endpointWith(CUSTOM, FUNNEL, SOLUS) })).toMatchObject({ address: SOLUS })
    expect(gate({ endpoint: endpointWith(CUSTOM, FUNNEL), addressTests: passed(FUNNEL) })).toMatchObject({ address: FUNNEL })
  })

  test('Tailscale Serve alone does not reach a cloud app: the person gets the three ways', () => {
    expect(gate({ endpoint: endpointWith(SERVE), uplink: NOT_REGISTERED })).toEqual({ kind: 'no-address', reach: 'internet', solus: { kind: 'not-registered' } })
  })

  test('a host that does not answer is offline, not checking forever', () => {
    expect(gate({ endpoint: null, endpointError: 'Host is offline' })).toEqual({ kind: 'offline', where: 'host', address: null, reason: 'Host is offline', canGoOn: false })
  })

  test('checks until the addresses and the link are read', () => {
    expect(gate({ endpoint: null })).toEqual({ kind: 'checking', testSource: null })
    expect(gate({ endpoint: LOCAL_ONLY, uplink: undefined })).toEqual({ kind: 'checking', testSource: null })
  })

  test('with no address, the Solus choice says where its link stands', () => {
    const solus = (uplink: UplinkStatus | undefined, extra: Partial<OutsideAppGateInput> = {}) => {
      const result = gate({ endpoint: LOCAL_ONLY, uplink, ...extra })
      return result.kind === 'no-address' ? result.solus : result
    }
    expect(solus(NOT_REGISTERED)).toEqual({ kind: 'not-registered' })
    expect(solus(UNLINKED)).toEqual({ kind: 'turn-on', turningOn: false, error: null })
    expect(solus({ registration: REGISTRATION, link: { linked: false, error: 'Rejected' } })).toMatchObject({ error: 'Rejected' })
    expect(solus(UNLINKED, { turningOn: true })).toMatchObject({ kind: 'turn-on', turningOn: true })
    expect(solus(linked('offline'), { turningOn: true })).toMatchObject({ kind: 'turn-on', turningOn: true })
    expect(solus(linked('error', 'Port 4810 is in use'))).toEqual({ kind: 'down', reason: 'Port 4810 is in use' })
    // The host answers, so a link it cannot read is not an offline host: Tailscale and the own address still work.
    expect(solus(undefined, { uplinkError: 'socket closed' })).toEqual({ kind: 'unreadable', reason: 'socket closed' })
  })
})

describe('an app on another computer than the host', () => {
  test('can use Tailscale Serve on the tailnet, after it is tested', () => {
    expect(gate({ addressKind: 'internet-or-tailnet', endpoint: endpointWith(SERVE), uplink: NOT_REGISTERED, addressTests: passed(SERVE) })).toEqual({ kind: 'open', mcpUrl: SERVE.url, address: SERVE, warning: null })
  })

  test('prefers an internet address to the tailnet one', () => {
    expect(gate({ addressKind: 'internet-or-tailnet', endpoint: endpointWith(SERVE, CUSTOM), addressTests: passed(CUSTOM) })).toMatchObject({ address: CUSTOM })
  })

  test('with no address at all, gets the three ways for any reach', () => {
    expect(gate({ addressKind: 'internet-or-tailnet', endpoint: LOCAL_ONLY, uplink: NOT_REGISTERED })).toMatchObject({ kind: 'no-address', reach: 'internet-or-tailnet' })
  })
})

describe('an app on the host computer', () => {
  test('skips every address gate and gets the local address', () => {
    for (const uplink of [NOT_REGISTERED, UNLINKED, linked('error', 'down'), undefined]) {
      expect(gate({ addressKind: 'local', endpoint: LOCAL_ONLY, uplink, addressTests: {} })).toEqual({ kind: 'open', mcpUrl: LOCAL, address: null, warning: null })
    }
  })

  test('Something else gets another address when the host has one, else the local one, with no test', () => {
    expect(gate({ addressKind: 'any-or-local', addressTests: {} })).toEqual({ kind: 'open', mcpUrl: SOLUS.url, address: SOLUS, warning: null })
    expect(gate({ addressKind: 'any-or-local', endpoint: LOCAL_ONLY, uplink: UNLINKED })).toEqual({ kind: 'open', mcpUrl: LOCAL, address: null, warning: null })
  })

  test('still waits for the host to answer', () => {
    expect(gate({ addressKind: 'local', endpoint: null })).toMatchObject({ kind: 'checking' })
  })
})

describe('where the Solus Cloud address is turned on', () => {
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

describe('the Solus Cloud card of the three ways', () => {
  test('one action for each state: sign in and link, link, or turn on', () => {
    expect(solusCard({ kind: 'not-registered' }, 'sign-in', 'here', 'Studio').action).toBe('sign-in')
    expect(solusCard({ kind: 'not-registered' }, 'register', 'here', 'Studio').action).toBe('link')
    expect(solusCard({ kind: 'turn-on', turningOn: false, error: null }, 'register', 'here', 'Studio').action).toBe('turn-on')
  })

  test('a person who cannot change it here reads where to do it, and a policy says it keeps it off', () => {
    expect(solusCard({ kind: 'not-registered' }, 'elsewhere', 'here', 'Studio')).toEqual({ summary: 'Link it from Studio itself, or from your Solus Cloud account.', action: 'check' })
    expect(solusCard({ kind: 'turn-on', turningOn: false, error: null }, 'register', 'elsewhere', 'Studio').summary).toBe('Turn it on from Studio itself.')
    expect(solusCard({ kind: 'turn-on', turningOn: false, error: null }, 'register', 'policy', 'Studio').action).toBe('policy')
  })

  test('a link that is down says why, and a card with nothing read yet offers nothing', () => {
    expect(solusCard({ kind: 'down', reason: 'Tunnel offline' }, 'register', 'here', 'Studio')).toEqual({ summary: 'Tunnel offline', action: 'check' })
    expect(solusCard(null, 'register', 'here', 'Studio')).toEqual({ summary: null, action: null })
  })
})
