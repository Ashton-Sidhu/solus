import { describe, expect, test } from 'bun:test'
import { uplinkControl } from '@solus/client-core/uplink-control'
import type { UplinkEnrollmentTicket, UplinkStatus } from '@solus/contracts/uplink'
import { HostCloudLink } from '../../apps/mobile/src/features/settings/host-cloud-link'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'

// Every host page offers its Solus Cloud link. The host accepts a link change
// only from a local owner (access-policy `local-only`), and a paired device is
// one, so a phone or browser paired with a host links it. An owner who came in
// through the tunnel must not get a control the host refuses — and an unlink
// would cut the very connection it came in on.

const UNLINKED: UplinkStatus = { linked: false }
const LINKED: UplinkStatus = {
  linked: true,
  link: {
    hostId: 'host-a',
    issuer: 'https://app.solus.sh',
    jwksUrl: 'https://app.solus.sh/jwks',
    directoryUrl: 'https://app.solus.sh',
    hostname: 'h-host-a.solus.run',
    proxiedPort: 4810,
    connectionGeneration: 1,
  },
  state: { observed: 'online' },
}
const TICKET: UplinkEnrollmentTicket = { ticket: 'tk-1', expiresAt: 0, directoryUrl: 'https://app.solus.sh' }

describe('who may change a host’s Solus Cloud link', () => {
  test('a paired device manages it, the tunnel only sees it, a member sees nothing', () => {
    expect(uplinkControl({ principal: 'local-owner', hostKind: 'personal' })).toBe('manage')
    expect(uplinkControl({ principal: 'remote-owner', hostKind: 'personal' })).toBe('view')
    expect(uplinkControl({ principal: 'org-member', hostKind: 'personal' })).toBe('none')
  })

  test('a managed host and the workspace service never offer one: Solus Cloud owns how they are reached', () => {
    expect(uplinkControl({ principal: 'local-owner', hostKind: 'managed' })).toBe('none')
    expect(uplinkControl({ principal: 'local-owner', hostKind: 'cloud' })).toBe('none')
  })
})

async function phoneWith(api: FakeApi, ticket: UplinkEnrollmentTicket | null = TICKET) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
  const cloud = new HostCloudLink((hostId) => world.connections.connection(hostId), async () => ticket)
  await cloud.load('inst-a')
  return { world, cloud }
}

describe('a phone links a host it is paired with', () => {
  test('links with a ticket from the phone’s own account', async () => {
    const api = new FakeApi()
      .on('connectionsGetServerInfo', () => ({ principal: 'local-owner', hostKind: 'personal' }))
      .on('uplinkStatus', () => UNLINKED)
      .on('uplinkLink', () => LINKED)
    const { cloud } = await phoneWith(api)
    await cloud.link('inst-a')
    expect(api.callsOf('uplinkLink')).toEqual([[{ ticket: 'tk-1', directoryUrl: 'https://app.solus.sh' }]])
    const state = cloud.stateOf('inst-a')
    expect(state.kind === 'loaded' && state.status?.linked).toBe(true)
  })

  test('signed out, the host is not asked and the phone says to sign in', async () => {
    const api = new FakeApi()
      .on('connectionsGetServerInfo', () => ({ principal: 'local-owner', hostKind: 'personal' }))
      .on('uplinkStatus', () => UNLINKED)
    const { cloud } = await phoneWith(api, null)
    await expect(cloud.link('inst-a')).rejects.toThrow('Sign in')
    expect(api.callsOf('uplinkLink')).toEqual([])
  })

  test('through the tunnel the phone sees the link and never asks to change it', async () => {
    const api = new FakeApi()
      .on('connectionsGetServerInfo', () => ({ principal: 'remote-owner', hostKind: 'personal' }))
      .on('uplinkStatus', () => LINKED)
    const { cloud } = await phoneWith(api)
    await cloud.unlink('inst-a')
    expect(api.callsOf('uplinkUnlink')).toEqual([])
    const state = cloud.stateOf('inst-a')
    expect(state.kind === 'loaded' && state.control).toBe('view')
  })

  test('the tunnel coming online after the link shows without a reload', async () => {
    const api = new FakeApi()
      .on('connectionsGetServerInfo', () => ({ principal: 'local-owner', hostKind: 'personal' }))
      .on('uplinkStatus', () => UNLINKED)
    const { world, cloud } = await phoneWith(api)
    world.transports[0]!.emit('host.uplinkStatusChanged', LINKED)
    await flushPromises()
    const state = cloud.stateOf('inst-a')
    expect(state.kind === 'loaded' && state.status?.linked).toBe(true)
  })
})
