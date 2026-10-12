import { describe, expect, test } from 'bun:test'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { HostFact } from '@solus/client-core/host-facts'
import { HostStanding } from '@solus/workspace-ui/contexts/hosts/host-standing.svelte'

// docs/plans/permissions.md §4: "may I, here" reads the grants the host sent, and the
// owner's standing until it has, so a control is disabled exactly when the host would
// refuse and never flickers on an owner.
const info = (over: Partial<ConnectionsServerInfo>): HostFact<ConnectionsServerInfo> => ({
  state: 'ready',
  value: { host: '127.0.0.1', port: 1, allowLan: false, installationId: 'i', remoteAccess: false, requireAuth: true, trustLocalNetwork: false, hostKind: 'personal', roles: ['execution'], principal: 'local-owner', grants: ['host'], ...over },
})

describe('host standing', () => {
  test('until the host answers, the client assumes the owner', () => {
    const me = new HostStanding('h', () => ({ state: 'loading' }))
    expect(me.may('host.git.write')).toBe(true)
    expect(me.isGuest).toBe(false)
  })

  test("a guest holds the host's few reads and nothing it could change", () => {
    const me = new HostStanding('h', () => info({ principal: 'guest', grants: ['host.connect', 'host.git.read', 'host.models.read'] }))
    expect(me.isGuest).toBe(true)
    expect(me.may('host.git.read')).toBe(true)
    expect(me.may('host.git.write')).toBe(false)
    expect(me.may('host.sessions.start')).toBe(false)
    expect(me.may('host.terminal')).toBe(false)
  })

  test('an older host without grants does not crash or give a guest owner actions', () => {
    const olderInfo = info({ principal: 'guest' })
    if (olderInfo.state !== 'ready') throw new Error('Expected ready host info')
    delete (olderInfo.value as Partial<ConnectionsServerInfo>).grants
    const me = new HostStanding('h', () => olderInfo)
    expect(me.grants).toEqual([])
    expect(me.may('host.git.write')).toBe(false)
  })

  test('an older local host keeps owner controls available', () => {
    const olderInfo = info({ principal: 'local-owner' })
    if (olderInfo.state !== 'ready') throw new Error('Expected ready host info')
    delete (olderInfo.value as Partial<ConnectionsServerInfo>).grants
    const me = new HostStanding('h', () => olderInfo)
    expect(me.may('host.git.write')).toBe(true)
  })

  test('a prefix covers what is under it, and a resource verb is asked of the resource', () => {
    const me = new HostStanding('h', () => info({ grants: ['host.git', 'host.use'] }))
    expect(me.may('host.git.write')).toBe(true)
    expect(me.may('host.admin')).toBe(false)
    // No share list is known for this resource: the client's own.
    expect(me.may('drive', { kind: 'session', id: 's1' })).toBe(true)
  })
})
