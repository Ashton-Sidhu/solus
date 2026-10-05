import { describe, expect, test } from 'bun:test'
import type { HostEvent } from '@solus/contracts/host-events'
import { eventVisibleTo } from '@solus/server/sharing/event-audience'
import type { Principal } from '@solus/server/admission/principal'
import type { ShareManager } from '@solus/server/sharing/share-manager'

// docs/plans/multiplayer-presence.md: a session's room reaches the people who can
// open that session; the host's roster reaches members and the owner, never a guest.

const MEMBER: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const GUEST: Principal = { kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', share: { resource: { kind: 'session', id: 's1' }, role: 'viewer', sharedByUserId: 'bob', linkSecretHash: 'h' }, expiresAt: 0, deviceLabel: 'Guest link' }

const WORK_GUEST: Principal = { kind: 'guest', guestId: 'g2', displayName: 'Ana', deviceId: 'g2', share: { resource: { kind: 'work', id: 'w1' }, role: 'viewer', sharedByUserId: 'bob', linkSecretHash: 'h' }, expiresAt: 0, deviceLabel: 'Guest link' }

const shares = {
  roleFor: async (principal: Principal, resource: { kind: string; id: string }) =>
    principal.kind === 'guest' && principal.share.resource.id === resource.id ? 'viewer' : 'none',
} as unknown as ShareManager

const sessionRoom = (sessionId: string): HostEvent => ({ type: 'session.presenceChanged', payload: { sessionId, participants: [], activeTurn: null }, occurredAt: 0 })
const hostRoom: HostEvent = { type: 'host.presenceChanged', payload: { participants: [] }, occurredAt: 0 }

describe('presence audiences', () => {
  test('a session room follows the session share; the host room never reaches a guest', async () => {
    expect(await eventVisibleTo(GUEST, sessionRoom('s1'), shares)).toBe(true)
    expect(await eventVisibleTo(GUEST, sessionRoom('s2'), shares)).toBe(false)
    expect(await eventVisibleTo(MEMBER, sessionRoom('s2'), shares)).toBe(false)
    expect(await eventVisibleTo(GUEST, hostRoom, shares)).toBe(false)
    expect(await eventVisibleTo(MEMBER, hostRoom, shares)).toBe(true)
  })

  test('a guest on a work link hears who has that work open, and no other work', async () => {
    // WHY: a shared work showed nobody else; the guest never had a room to read.
    const workRoom = (workId: string): HostEvent => ({ type: 'work.presenceChanged', payload: { workId, participants: [] }, occurredAt: 0 })
    expect(await eventVisibleTo(WORK_GUEST, workRoom('w1'), shares)).toBe(true)
    expect(await eventVisibleTo(WORK_GUEST, workRoom('w2'), shares)).toBe(false)
    expect(await eventVisibleTo(GUEST, workRoom('w1'), shares)).toBe(false)
    expect(await eventVisibleTo(WORK_GUEST, hostRoom, shares)).toBe(false)
  })
})
