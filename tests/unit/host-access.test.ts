import { describe, expect, test } from 'bun:test'
import { bestPairEndpoint, pairLink, parsePairLink } from '@solus/client-core/pairing'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { connectedAppDetail, connectedApps, HostAccess, networkNote, pairedDeviceDetail, showsPairedDevices, type HostEndpoint } from '../../apps/mobile/solus-core/features/settings/host-access'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

// A host's Access screen on the phone shows what the desktop and web Access tab
// shows: network, pairing, devices, and organizations. The rules a person would
// notice going wrong: a host that cannot read its organizations still shows the
// rest; a change the host refused leaves the screen as the host holds it; and
// turning on remote connections shows the addresses the host now listens on.

const INFO = { principal: 'local-owner', hostKind: 'personal', host: '127.0.0.1', port: 4810, allowLan: false, remoteAccess: 'off', trustLocalNetwork: false } as const
const LOOPBACK: HostEndpoint = { kind: 'loopback', label: 'This computer', host: '127.0.0.1', port: 4810 }
const LAN: HostEndpoint = { kind: 'lan', label: 'Wi-Fi', host: '192.168.1.20', port: 4810 }
const ORGANIZATIONS: HostOrganizationsStatus = {
  registered: true, hostId: 'host-a', kind: 'personal', owner: null, apiUrl: null, delivery: [], deliveryError: null,
  organizations: [{ organizationId: 'org-1', name: 'Acme', shared: true, policy: { syncAllInsights: false, allowsPersonalHosts: true, allowsCloudHosts: true } }],
  insightsOptIn: [],
}

function hostApi(): FakeApi {
  return new FakeApi()
    .on('connectionsGetServerInfo', () => INFO)
    .on('connectionsListEndpoints', () => [LOOPBACK])
    .on('connectionsListSessions', () => [])
    .on('connectionsListDevices', () => [])
    .on('hostOrganizations', () => ORGANIZATIONS)
    .on('connectionsAppEndpoint', () => ({ localUrl: 'http://localhost:4810/mcp', publicUrl: null }))
}

async function phoneWith(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
  const access = new HostAccess((hostId) => world.connections.connection(hostId))
  await access.load('inst-a')
  return { world, access }
}

function loaded(access: HostAccess) {
  const state = access.stateOf('inst-a')
  if (state.kind !== 'loaded') throw new Error(`expected loaded, got ${state.kind}`)
  return state
}

describe('a host’s Access screen on the phone', () => {
  test('a host that cannot read its organizations still shows its network and devices', async () => {
    const api = hostApi().on('hostOrganizations', () => { throw new Error('control plane away') })
    const { access } = await phoneWith(api)
    expect(loaded(access).organizations).toBeNull()
    expect(loaded(access).organizationsError).toBe('control plane away')
    expect(loaded(access).info.port).toBe(4810)
  })

  test('turning on remote connections shows the addresses the host now listens on', async () => {
    const api = hostApi().on('connectionsSetRemoteAccess', () => ({ remoteAccess: 'any', host: '0.0.0.0', port: 4810, allowLan: true, requireAuth: true }))
    const { access } = await phoneWith(api)
    api.on('connectionsListEndpoints', () => [LOOPBACK, LAN])
    await access.setRemoteAccess('inst-a', 'any')
    expect(loaded(access).info.remoteAccess).toBe('any')
    expect(loaded(access).endpoints).toContainEqual(LAN)
    expect(loaded(access).busy).toBeNull()
  })

  test('a change the host refused leaves the screen as the host holds it', async () => {
    const api = hostApi().on('connectionsSetTrustLocalNetwork', () => { throw new Error('only a local connection') })
    const { access } = await phoneWith(api)
    await expect(access.setTrustLocalNetwork('inst-a', true)).rejects.toThrow('only a local connection')
    expect(loaded(access).info.trustLocalNetwork).toBe(false)
    expect(loaded(access).busy).toBeNull()
  })

  test('a revoked device leaves the list', async () => {
    const device = { id: 'c1', deviceLabel: 'Laptop', deviceId: 'd1', connectedAt: 0, connectionCount: 1, connectionIds: ['c1'] }
    const api = hostApi().on('connectionsListSessions', () => [device]).on('connectionsRevokeDevice', () => ({ ok: true }))
    const { access } = await phoneWith(api)
    api.on('connectionsListSessions', () => [])
    await access.revokeDevice('inst-a', 'd1')
    expect(api.callsOf('connectionsRevokeDevice')).toEqual([[{ deviceId: 'd1' }]])
    expect(loaded(access).devices).toEqual([])
  })

  test('a paired device that is not connected is listed, and Revoke reads the pairings again', async () => {
    const tablet = { deviceId: 'd2', deviceLabel: 'Tablet', pairedAt: 0, lastSeenAt: 0, revokedAt: null }
    const api = hostApi().on('connectionsListDevices', () => [tablet]).on('connectionsRevokeDevice', () => ({ ok: true }))
    const { access } = await phoneWith(api)
    expect(loaded(access).pairedDevices).toEqual([tablet])
    api.on('connectionsListDevices', () => [{ ...tablet, revokedAt: 5 }])
    await access.revokeDevice('inst-a', 'd2')
    expect(loaded(access).pairedDevices[0]?.revokedAt).toBe(5)
  })

  test('a host that refuses its pairings says why and still shows the rest', async () => {
    const api = hostApi().on('connectionsListDevices', () => { throw new Error('only the host administrator') })
    const { access } = await phoneWith(api)
    expect(loaded(access).pairedDevicesError).toBe('only the host administrator')
    expect(loaded(access).info.port).toBe(4810)
  })

  test('only the owner of a personal host sees its pairings, each as connected, last seen, or revoked', () => {
    expect(showsPairedDevices(INFO)).toBe(true)
    expect(showsPairedDevices({ ...INFO, principal: 'org-member' })).toBe(false)
    expect(showsPairedDevices({ ...INFO, hostKind: 'cloud' })).toBe(false)
    const now = Date.parse('2026-11-20T12:00:00Z')
    const device = { deviceId: 'd1', deviceLabel: 'Phone', pairedAt: now - 3 * 86_400_000, lastSeenAt: now - 2 * 3_600_000, revokedAt: null }
    expect(pairedDeviceDetail(device, true, now)).toBe('Connected now · paired 3d ago')
    expect(pairedDeviceDetail(device, false, now)).toBe('Last seen 2h ago · paired 3d ago')
    expect(pairedDeviceDetail({ ...device, revokedAt: now - 60_000 }, false, now)).toBe('Revoked 1m ago')
  })

  test('an organization change made elsewhere shows without a reload', async () => {
    const { world, access } = await phoneWith(hostApi())
    world.transports[0]!.emit('host.organizationsChanged', { ...ORGANIZATIONS, insightsOptIn: ['org-1'] })
    await flushPromises()
    expect(loaded(access).organizations?.insightsOptIn).toEqual(['org-1'])
  })

  test('through the tunnel the note says where to change the network', () => {
    expect(networkNote({ ...INFO, principal: 'remote-owner' })).toContain('Change these from the host itself')
    expect(networkNote(INFO)).not.toContain('Change these')
  })
})

describe('outside apps on a host’s Access screen', () => {
  // An outside app (Claude Desktop, Cursor) signs in to the host with OAuth and
  // uses its tools (plans/035 §10). The owner needs the address to give the app,
  // a pairing code to type on its sign-in page, and the apps that still have access.

  test('the address the app needs shows, and a host that refuses it still shows the rest', async () => {
    const api = hostApi().on('connectionsAppEndpoint', () => ({ localUrl: 'http://localhost:4810/mcp', publicUrl: 'https://box.tunnel.example/mcp' }))
    const { access } = await phoneWith(api)
    expect(loaded(access).appEndpoint?.publicUrl).toBe('https://box.tunnel.example/mcp')

    const refused = await phoneWith(hostApi().on('connectionsAppEndpoint', () => { throw new Error('only the host administrator') }))
    expect(loaded(refused.access).appEndpoint).toBeNull()
    expect(loaded(refused.access).appEndpointError).toBe('only the host administrator')
    expect(loaded(refused.access).info.port).toBe(4810)
  })

  test('a pairing code stays on screen through a reload, and a refused code changes nothing', async () => {
    const api = hostApi().on('connectionsCreateAppPairingCode', () => ({ code: 'ABCD-EFGH', expiresAt: 600_000 }))
    const { access } = await phoneWith(api)
    await access.createAppPairCode('inst-a')
    expect(loaded(access).appPair).toEqual({ code: 'ABCD-EFGH', expiresAt: 600_000 })
    await access.load('inst-a')
    expect(loaded(access).appPair?.code).toBe('ABCD-EFGH')

    const policy = hostApi().on('connectionsCreateAppPairingCode', () => { throw new Error('Your organization turned off connecting outside apps') })
    const blocked = await phoneWith(policy)
    await expect(blocked.access.createAppPairCode('inst-a')).rejects.toThrow('turned off')
    expect(loaded(blocked.access).appPair).toBeNull()
    expect(loaded(blocked.access).busy).toBeNull()
  })

  test('only apps that still have access are listed, each with its access, and Revoke removes one', async () => {
    const now = Date.parse('2026-11-20T12:00:00Z')
    const tablet = { deviceId: 'd1', deviceLabel: 'Tablet', pairedAt: now, lastSeenAt: now, revokedAt: null }
    const cursor = { deviceId: 'a1', deviceLabel: 'Cursor', pairedAt: now - 86_400_000, lastSeenAt: now - 3_600_000, revokedAt: null, app: { access: 'write' as const } }
    const old = { ...cursor, deviceId: 'a0', revokedAt: now - 60_000 }
    expect(connectedApps([tablet, cursor, old])).toEqual([cursor])
    expect(connectedAppDetail(cursor, now)).toBe('Read and write access · Last seen 1h ago · paired 1d ago')
    expect(connectedAppDetail({ ...cursor, app: { access: 'read' } }, now)).toStartWith('Read access ·')
    expect(connectedAppDetail({ ...cursor, app: { access: 'full' } }, now)).toStartWith('Full access ·')

    const api = hostApi().on('connectionsListDevices', () => [tablet, cursor]).on('connectionsRevokeDevice', () => ({ ok: true }))
    const { access } = await phoneWith(api)
    api.on('connectionsListDevices', () => [tablet, { ...cursor, revokedAt: now }])
    await access.revokeDevice('inst-a', 'a1')
    expect(api.callsOf('connectionsRevokeDevice')).toEqual([[{ deviceId: 'a1' }]])
    expect(connectedApps(loaded(access).pairedDevices)).toEqual([])
  })
})

describe('the pairing link', () => {
  test('names the widest-reaching address, and pairing reads it back', () => {
    const endpoint = bestPairEndpoint([LOOPBACK, LAN])
    expect(endpoint?.kind).toBe('lan')
    expect(parsePairLink(pairLink(endpoint!, 'tok'))).toEqual({ url: 'http://192.168.1.20:4810', pairToken: 'tok' })
  })
})
