import { describe, expect, test } from 'bun:test'
import { bestPairEndpoint, pairLink, parsePairLink } from '@solus/client-core/pairing'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { HostAccess, networkNote, type HostEndpoint } from '../../apps/mobile/src/features/settings/host-access'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'

// A host's Access screen on the phone shows what the desktop and web Access tab
// shows: network, pairing, devices, and organizations. The rules a person would
// notice going wrong: a host that cannot read its organizations still shows the
// rest; a change the host refused leaves the screen as the host holds it; and
// turning on remote connections shows the addresses the host now listens on.

const INFO = { principal: 'local-owner', hostKind: 'personal', host: '127.0.0.1', port: 4810, allowLan: false, remoteAccess: false, trustLocalNetwork: false } as const
const LOOPBACK: HostEndpoint = { kind: 'loopback', label: 'This computer', host: '127.0.0.1', port: 4810 }
const LAN: HostEndpoint = { kind: 'lan', label: 'Wi-Fi', host: '192.168.1.20', port: 4810 }
const ORGANIZATIONS: HostOrganizationsStatus = {
  linked: true, hostId: 'host-a', category: 'personal', owner: null, attachedAt: null, apiUrl: null, delivery: [], deliveryError: null,
  organizations: [{ organizationId: 'org-1', name: 'Acme', shared: true, policy: { syncAllInsights: false, allowsPersonalHosts: true, allowsCloudHosts: true } }],
  insightsOptIn: [],
}

function hostApi(): FakeApi {
  return new FakeApi()
    .on('connectionsGetServerInfo', () => INFO)
    .on('connectionsListEndpoints', () => [LOOPBACK])
    .on('connectionsListSessions', () => [])
    .on('hostOrganizations', () => ORGANIZATIONS)
}

async function phoneWith(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
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
    const api = hostApi().on('connectionsSetRemoteAccess', () => ({ remoteAccess: true, host: '0.0.0.0', port: 4810, allowLan: true, requireAuth: true }))
    const { access } = await phoneWith(api)
    api.on('connectionsListEndpoints', () => [LOOPBACK, LAN])
    await access.setRemoteAccess('inst-a', true)
    expect(loaded(access).info.remoteAccess).toBe(true)
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
    const api = hostApi().on('connectionsListSessions', () => [device]).on('connectionsRevokeDevice', () => ({ ok: true, revoked: ['c1'] }))
    const { access } = await phoneWith(api)
    api.on('connectionsListSessions', () => [])
    await access.revokeDevice('inst-a', 'd1')
    expect(api.callsOf('connectionsRevokeDevice')).toEqual([[{ deviceId: 'd1' }]])
    expect(loaded(access).devices).toEqual([])
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

describe('the pairing link', () => {
  test('names the widest-reaching address, and pairing reads it back', () => {
    const endpoint = bestPairEndpoint([LOOPBACK, LAN])
    expect(endpoint?.kind).toBe('lan')
    expect(parsePairLink(pairLink(endpoint!, 'tok'))).toEqual({ url: 'http://192.168.1.20:4810', pairToken: 'tok' })
  })
})
