import { describe, expect, test } from 'bun:test'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { HostFact } from '@solus/client-core/host-facts'
import { HostStanding } from '@solus/workspace-ui/contexts/hosts/host-standing.svelte'

// docs/plans/permissions.md §4: "may I, here" reads the permissions the host sent, and the
// owner's standing until it has, so a control is disabled exactly when the host would
// refuse and never flickers on an owner.
const info = (over: Partial<ConnectionsServerInfo>): HostFact<ConnectionsServerInfo> => ({
  state: 'ready',
  value: { host: '127.0.0.1', port: 1, allowLan: false, installationId: 'i', remoteAccess: false, requireAuth: true, trustLocalNetwork: false, hostKind: 'personal', roles: ['execution'], principal: 'local-owner', permissions: ['host'], ...over },
})

const notGone = () => false

describe('host standing', () => {
  test('until the host answers, the client assumes the owner', () => {
    const me = new HostStanding('h', () => ({ state: 'loading' }), notGone)
    expect(me.may('host.git.write')).toBe(true)
    expect(me.isGuest).toBe(false)
  })

  test("a guest holds the host's few reads and nothing it could change", () => {
    const me = new HostStanding('h', () => info({ principal: 'guest', permissions: ['host.connect', 'host.git.read', 'host.models.read'] }), notGone)
    expect(me.isGuest).toBe(true)
    expect(me.may('host.git.read')).toBe(true)
    expect(me.may('host.git.write')).toBe(false)
    expect(me.may('host.sessions.start')).toBe(false)
    expect(me.may('host.terminal')).toBe(false)
  })

  test('a host that sends no permissions does not crash or give a guest owner permissions', () => {
    const olderInfo = info({ principal: 'guest' })
    if (olderInfo.state !== 'ready') throw new Error('Expected ready host info')
    delete (olderInfo.value as Partial<ConnectionsServerInfo>).permissions
    const me = new HostStanding('h', () => olderInfo, notGone)
    expect(me.permissions).toEqual([])
    expect(me.may('host.git.write')).toBe(false)
  })

  test('a local host that sends no permissions keeps owner controls available', () => {
    const olderInfo = info({ principal: 'local-owner' })
    if (olderInfo.state !== 'ready') throw new Error('Expected ready host info')
    delete (olderInfo.value as Partial<ConnectionsServerInfo>).permissions
    const me = new HostStanding('h', () => olderInfo, notGone)
    expect(me.may('host.git.write')).toBe(true)
  })

  test('a prefix covers what is under it, and a resource verb is asked of the resource', () => {
    const me = new HostStanding('h', () => info({ permissions: ['host.git', 'host.use'] }), notGone)
    expect(me.may('host.git.write')).toBe(true)
    expect(me.may('host.admin')).toBe(false)
    // No share list is known for this resource: the client's own.
    expect(me.may('drive', { kind: 'session', id: 's1' })).toBe(true)
  })

  test('a resource verb reads the role the resource carries, for a kind that cannot be shared too', () => {
    // WHY: access-model.md §2.7 — a member lists every project of the
    // organization, but rename and remove follow the role the host sent.
    const me = new HostStanding('h', () => info({}), notGone)
    expect(me.may('edit', { kind: 'project', id: 'p1', role: 'none' })).toBe(false)
    expect(me.may('edit', { kind: 'project', id: 'p2', role: 'editor' })).toBe(true)
    expect(me.may('edit', { kind: 'automation', id: 'a1', role: 'viewer' })).toBe(false)
    expect(me.may('read', { kind: 'automation', id: 'a1', role: 'viewer' })).toBe(true)
  })

  test('a gone host allows nothing, though it never answered', () => {
    // A gone host has no server info, and the owner's standing would offer
    // actions whose calls can only fail.
    const me = new HostStanding('h', () => ({ state: 'loading' }), () => true)
    expect(me.may('host.git.write')).toBe(false)
    expect(me.may('host.sessions.start')).toBe(false)
  })
})
