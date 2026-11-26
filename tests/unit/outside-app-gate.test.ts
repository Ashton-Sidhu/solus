import { describe, expect, test } from 'bun:test'
import type { AppAddress } from '@solus/contracts/host-api'
import type { UplinkStatus } from '@solus/contracts/uplink'
import { appAddressesOf, cloudAppAddress, publicAddressInput } from '../../apps/mobile/solus-core/features/settings/app-addresses'
import { HostAccess, type AppAddressTestState, type HostAccessState } from '../../apps/mobile/solus-core/features/settings/host-access'
import type { HostCloudLinkState } from '../../apps/mobile/solus-core/features/settings/host-cloud-link'
import { addressToTest, isTunnelOnline, outsideAppGate, outsideAppGateMessage } from '../../apps/mobile/solus-core/features/settings/outside-app-gate'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

// The phone connects only apps that run in the cloud, so the steps open only when
// the host has an address that the internet reaches and that address answers. A
// host does not have to be linked to a Solus account: Tailscale Funnel or the
// person's own ingress serves /mcp too. The phone is never the host machine: it
// cannot turn the tunnel or Funnel on, so it says where to, and a person who may
// change host settings types their own address there.

const SOLUS: AppAddress = { source: 'solus', url: 'https://h-box.tunnel.example/mcp', reach: 'internet' }
const FUNNEL: AppAddress = { source: 'tailscale-funnel', url: 'https://box.tail1.ts.net/mcp', reach: 'internet' }
const SERVE: AppAddress = { source: 'tailscale-serve', url: 'https://box.tail1.ts.net/mcp', reach: 'tailnet' }
const CUSTOM: AppAddress = { source: 'custom', url: 'https://solus.example.com/mcp', reach: 'internet' }
const REGISTERED: UplinkStatus['registration'] = { registered: true, owner: null, registration: { hostId: 'box', kind: 'personal' } as never }
const ONLINE: UplinkStatus['link'] = { linked: true, tunnel: { hostname: 'h-box.tunnel.example', proxiedPort: 4810 }, state: { observed: 'online' } }

function accessWith(addresses: AppAddress[], appEndpointError: string | null = null): HostAccessState {
  return {
    kind: 'loaded',
    info: {} as never,
    endpoints: [], devices: [], pairedDevices: [], pairedDevicesError: null,
    organizations: null, organizationsError: null, pair: null,
    appEndpoint: appEndpointError ? null : { localUrl: 'http://localhost:4810/mcp', publicUrl: addresses.find((a) => a.reach === 'internet')?.url ?? null, addresses },
    appEndpointError, appPair: null, busy: null,
  }
}

const linkWith = (status: UplinkStatus | null): HostCloudLinkState => ({ kind: 'loaded', control: 'none', status, busy: false })
const passed = (address: AppAddress): AppAddressTestState => ({ kind: 'done', url: address.url, reachable: true, reason: null })

function gateOf(input: { access?: HostAccessState; cloudLink?: HostCloudLinkState; addressTest?: AppAddressTestState | null }) {
  return outsideAppGate({
    access: input.access ?? accessWith([SOLUS]),
    cloudLink: input.cloudLink ?? { kind: 'idle' },
    addressTest: input.addressTest === undefined ? passed(SOLUS) : input.addressTest,
  })
}

describe('the address a cloud app uses', () => {
  test('the Solus tunnel first, then Tailscale Funnel, then the person\'s own; never Tailscale Serve', () => {
    expect(cloudAppAddress([CUSTOM, FUNNEL, SOLUS])).toEqual(SOLUS)
    expect(cloudAppAddress([CUSTOM, SERVE, FUNNEL])).toEqual(FUNNEL)
    expect(cloudAppAddress([SERVE, CUSTOM])).toEqual(CUSTOM)
    expect(cloudAppAddress([SERVE])).toBeNull()
  })

  test('an older host that lists no addresses gives its public tunnel address as the Solus one', () => {
    expect(appAddressesOf({ localUrl: 'http://localhost:4810/mcp', publicUrl: SOLUS.url } as never)).toEqual([SOLUS])
    expect(appAddressesOf({ localUrl: 'http://localhost:4810/mcp', publicUrl: null } as never)).toEqual([])
  })

  test('the person\'s own address is kept as an https origin, or empty for none', () => {
    expect(publicAddressInput(' https://solus.example.com/some/path ')).toEqual({ ok: true, value: 'https://solus.example.com' })
    expect(publicAddressInput('')).toEqual({ ok: true, value: '' })
    expect(publicAddressInput('http://solus.example.com').ok).toBe(false)
    expect(publicAddressInput('solus.example.com').ok).toBe(false)
  })
})

describe('the gate before connecting an outside app from the phone', () => {
  test('an address that answers opens the steps with that address and its source', () => {
    expect(gateOf({})).toEqual({ kind: 'open', address: SOLUS })
    expect(gateOf({ access: accessWith([SERVE, FUNNEL]), addressTest: passed(FUNNEL) })).toEqual({ kind: 'open', address: FUNNEL })
    expect(gateOf({ access: accessWith([CUSTOM]), addressTest: passed(CUSTOM) })).toEqual({ kind: 'open', address: CUSTOM })
  })

  test('a host that is not linked to a Solus account still opens the steps with Funnel or its own address', () => {
    const notRegistered = linkWith({ registration: { registered: false }, link: { linked: false } })
    expect(gateOf({ access: accessWith([FUNNEL]), cloudLink: notRegistered, addressTest: passed(FUNNEL) }).kind).toBe('open')
  })

  test('while the host is read, the screen says it is checking', () => {
    expect(gateOf({ access: { kind: 'loading' } })).toEqual({ kind: 'checking', step: 'host' })
    expect(gateOf({ access: { kind: 'idle' } })).toEqual({ kind: 'checking', step: 'host' })
  })

  test('the address is tested before the steps open, and a test of another address does not count', () => {
    expect(gateOf({ addressTest: null })).toEqual({ kind: 'checking', step: 'address' })
    expect(gateOf({ addressTest: { kind: 'running', url: SOLUS.url } })).toEqual({ kind: 'checking', step: 'address' })
    expect(gateOf({ access: accessWith([CUSTOM]), addressTest: passed(SOLUS) })).toEqual({ kind: 'checking', step: 'address' })
    expect(addressToTest(gateOf({ addressTest: null }), accessWith([SOLUS]))).toEqual(SOLUS)
    expect(addressToTest(gateOf({}), accessWith([SOLUS]))).toBeNull()
  })

  test('an address that does not answer blocks the steps with the reason', () => {
    expect(gateOf({ addressTest: { kind: 'done', url: SOLUS.url, reachable: false, reason: 'No answer in 5 seconds.' } }))
      .toEqual({ kind: 'unreachable', address: SOLUS, reason: 'No answer in 5 seconds.' })
    expect(gateOf({ addressTest: { kind: 'done', url: SOLUS.url, reachable: false, reason: null } }))
      .toEqual({ kind: 'unreachable', address: SOLUS, reason: 'The address did not answer.' })
    expect(gateOf({ addressTest: { kind: 'error', url: SOLUS.url, message: 'Unknown method.' } }))
      .toEqual({ kind: 'unreachable', address: SOLUS, reason: 'Unknown method.' })
  })

  test('with no address the internet reaches, the gate names how far the Solus link got', () => {
    expect(gateOf({ access: accessWith([]) })).toEqual({ kind: 'no-address', solus: null, hasTailnetAddress: false })
    expect(gateOf({ access: accessWith([SERVE]), cloudLink: linkWith({ registration: { registered: false }, link: { linked: false } }) }))
      .toEqual({ kind: 'no-address', solus: { kind: 'not-registered' }, hasTailnetAddress: true })
    expect(gateOf({ access: accessWith([]), cloudLink: linkWith({ registration: REGISTERED, link: { linked: false, error: 'The link expired.' } }) }))
      .toEqual({ kind: 'no-address', solus: { kind: 'tunnel-off', reason: 'The link expired.' }, hasTailnetAddress: false })
  })

  test('a host that cannot be read, or refuses its addresses, says why', () => {
    expect(gateOf({ access: { kind: 'error', message: 'This host cannot be reached now.' } }))
      .toEqual({ kind: 'offline', reason: 'This host cannot be reached now.' })
    expect(gateOf({ access: accessWith([], 'only the host administrator') })).toEqual({ kind: 'offline', reason: 'only the host administrator' })
  })

  test('a tunnel that came online makes the phone read the addresses again', () => {
    expect(isTunnelOnline(linkWith({ registration: REGISTERED, link: ONLINE }))).toBe(true)
    expect(isTunnelOnline(linkWith({ registration: REGISTERED, link: { linked: false } }))).toBe(false)
  })
})

describe('what the phone says when the gate is not open', () => {
  const noAddress = { kind: 'no-address', solus: null, hasTailnetAddress: true } as const

  test('it gives the three ways, says Serve alone is not enough, and offers Check again', () => {
    const message = outsideAppGateMessage(noAddress, 'Studio Mac', { mayChangeHostSettings: true })
    expect(message.title).toBe('Give Studio Mac an address apps can reach')
    expect(message.ways.map((way) => way.label)).toEqual(['Link the host to your Solus account', 'Turn on Tailscale Funnel', 'Use your own address'])
    expect(message.ways[1]!.detail).toContain('Tailscale Serve alone reaches only the devices on your tailnet')
    expect(message.canCheckAgain).toBe(true)
  })

  test('only a person who may change host settings gets the field for their own address; others are told the owner sets it', () => {
    expect(outsideAppGateMessage(noAddress, 'Studio Mac', { mayChangeHostSettings: true }).showsAddressField).toBe(true)
    const member = outsideAppGateMessage(noAddress, 'Studio Mac', { mayChangeHostSettings: false })
    expect(member.showsAddressField).toBe(false)
    expect(member.ways[2]!.detail).toContain('The owner of Studio Mac sets')
  })

  test('the Solus way says where to act on the host for each step of the link', () => {
    const detail = (solus: Parameters<typeof outsideAppGateMessage>[0] & { kind: 'no-address' }) =>
      outsideAppGateMessage(solus, 'Studio Mac', { mayChangeHostSettings: false }).ways[0]!.detail
    expect(detail({ ...noAddress, solus: { kind: 'not-registered' } })).toContain('On Studio Mac, open Solus and sign in.')
    expect(detail({ ...noAddress, solus: { kind: 'tunnel-off', reason: 'The link expired.' } })).toContain('turn on Reachable from the internet. You cannot turn it on from a phone. The link expired.')
  })

  test('an own address that does not answer can be fixed from the phone; another source cannot', () => {
    const own = outsideAppGateMessage({ kind: 'unreachable', address: CUSTOM, reason: 'TLS failed.' }, 'Studio Mac', { mayChangeHostSettings: true })
    expect(own.lines).toEqual([`${CUSTOM.url} (Your own address)`, 'TLS failed.'])
    expect(own.showsAddressField).toBe(true)
    expect(outsideAppGateMessage({ kind: 'unreachable', address: FUNNEL, reason: 'x' }, 'Studio Mac', { mayChangeHostSettings: true }).showsAddressField).toBe(false)
    expect(outsideAppGateMessage({ kind: 'checking', step: 'address' }, 'Studio Mac', { mayChangeHostSettings: true }).canCheckAgain).toBe(false)
  })
})

describe('the host tests an app address on the phone', () => {
  const api = () => new FakeApi()
    .on('connectionsGetServerInfo', () => ({ principal: 'local-owner', hostKind: 'personal' }))
    .on('connectionsListEndpoints', () => [])
    .on('connectionsListSessions', () => [])
    .on('connectionsListDevices', () => [])
    .on('hostOrganizations', () => null)
    .on('connectionsAppEndpoint', () => ({ localUrl: 'http://localhost:4810/mcp', publicUrl: null, addresses: [CUSTOM] }))

  async function phoneWith(fake: FakeApi) {
    const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => fake })
    await world.registry.load()
    await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
    const access = new HostAccess((hostId) => world.connections.connection(hostId))
    await access.load('inst-a')
    return { world, access }
  }

  test('it asks the host to test the source, and keeps the answer for that address', async () => {
    const fake = api().on('connectionsTestAppAddress', () => ({ reachable: false, reason: 'TLS failed.' }))
    const { access } = await phoneWith(fake)
    const run = access.testAppAddress('inst-a', CUSTOM)
    expect(access.addressTestOf('inst-a')).toEqual({ kind: 'running', url: CUSTOM.url })
    await run
    expect(fake.callsOf('connectionsTestAppAddress')).toEqual([[{ source: 'custom' }]])
    expect(access.addressTestOf('inst-a')).toEqual({ kind: 'done', url: CUSTOM.url, reachable: false, reason: 'TLS failed.' })
  })

  test('a new read of the host, or a changed host setting, drops a finished test: the address may answer now', async () => {
    const fake = api().on('connectionsTestAppAddress', () => ({ reachable: false, reason: 'TLS failed.' }))
    const { world, access } = await phoneWith(fake)
    await access.testAppAddress('inst-a', CUSTOM)
    await access.load('inst-a')
    expect(access.addressTestOf('inst-a')).toBeNull()
    await access.testAppAddress('inst-a', CUSTOM)
    world.transports[0]!.emit('config.changed', { config: {} } as never)
    await flushPromises()
    expect(access.addressTestOf('inst-a')).toBeNull()
  })
})
