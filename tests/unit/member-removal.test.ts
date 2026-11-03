import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { HostOrganization } from '@solus/contracts/uplink'
import type { Principal } from '@solus/server/admission/principal'
import { SeatManager } from '@solus/server/execution/seats/seat-manager'
import { removeDepartedMembers } from '@solus/server/host/departed-members'
import type { HostStanding } from '@solus/server/host/organizations'
import type { ShareManager as ShareManagerType } from '@solus/server/sharing/share-manager'
import { resetTestDatabase } from './helpers/test-db'
import { seedResource } from './helpers/resource-rows'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// Plan 004 item 10: the host learns of a removal from its organization standing,
// which lists every current member of each organization the machine is shared with.
// A removed person loses their seats and their open sockets, and nobody else does;
// a host admin may then hand on what they owned, and an ordinary member may not.

const policy = { allowsPersonalHosts: true, syncAllInsights: false } as HostOrganization['policy']
const member = (userId: string, organizationRole: 'owner' | 'member' = 'member', organizationId = 'org1'): Principal => ({
  kind: 'org-member', userId, organizationId, organizationRole, teamIds: [], hostKind: 'managed', displayName: userId, deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})
const standing = (organizations: Array<Partial<HostOrganization> & { organizationId: string }>): HostStanding => ({
  hostId: 'h1',
  category: 'managed',
  owner: null,
  organizations: organizations.map((entry) => ({ name: entry.organizationId, shared: true, policy, ...entry })),
  refreshedAt: 0,
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function seatManager() {
  const root = mkdtempSync(join(tmpdir(), 'member-removal-'))
  roots.push(root)
  return new SeatManager({
    db: new Database(':memory:') as unknown as DatabaseSync,
    seatsRoot: join(root, 'seats'),
    hostClaudeDir: join(root, 'home', '.claude'),
    hostCodexHome: join(root, 'home', '.codex'),
    hostLoginConnected: async () => true,
  })
}

/** Open sockets as the transport holds them: `disconnectWhere` ends the matching ones. */
function sockets(principals: Principal[]) {
  const open = [...principals]
  return {
    open,
    disconnectWhere: (predicate: (principal: Principal) => boolean) => {
      const ended = open.filter(predicate)
      for (const principal of ended) open.splice(open.indexOf(principal), 1)
      return ended.length
    },
  }
}

describe('a member removed from the organization', () => {
  test('loses their seats and sockets; everyone else keeps theirs', async () => {
    const seats = seatManager()
    await seats.storeToken({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } }, 'claude-code', 'sk-bob')
    await seats.storeToken({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } }, 'codex', '{"tokens":{}}')
    await seats.storeToken({ kind: 'user', userId: { kind: 'account', accountId: 'cara' } }, 'claude-code', 'sk-cara')
    const bobHome = seats.homeFor({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } }, 'claude-code')
    const transport = sockets([member('bob'), member('bob'), member('cara'), { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }])

    const outcome = await removeDepartedMembers(standing([{ organizationId: 'org1', memberUserIds: ['alice', 'cara'] }]), { seats, disconnectWhere: transport.disconnectWhere })

    expect(outcome).toEqual({ seatUserIds: ['bob'], socketsClosed: 2 })
    expect(seats.memberUserIds()).toEqual(['cara'])
    expect(existsSync(bobHome)).toBe(false)
    expect((await seats.status({ kind: 'user', userId: { kind: 'account', accountId: 'cara' } }, 'claude-code')).state).toBe('connected')
    expect(transport.open.map((principal) => principal.kind === 'org-member' ? principal.userId : principal.kind)).toEqual(['cara', 'owner'])
  })

  test('a standing without member lists removes nobody', async () => {
    // WHY: an older control plane sends no list; a seat is a person's login and must
    // not be deleted on a guess.
    const seats = seatManager()
    await seats.storeToken({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } }, 'claude-code', 'sk-bob')
    const transport = sockets([member('bob')])
    expect(await removeDepartedMembers(standing([{ organizationId: 'org1' }]), { seats, disconnectWhere: transport.disconnectWhere }))
      .toEqual({ seatUserIds: [], socketsClosed: 0 })
    expect(await removeDepartedMembers(null, { seats, disconnectWhere: transport.disconnectWhere }))
      .toEqual({ seatUserIds: [], socketsClosed: 0 })
    expect(seats.memberUserIds()).toEqual(['bob'])
  })

  test('a person still in another shared organization keeps their seat', async () => {
    const seats = seatManager()
    await seats.storeToken({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } }, 'claude-code', 'sk-bob')
    const transport = sockets([member('bob', 'member', 'org1'), member('bob', 'member', 'org2')])
    const outcome = await removeDepartedMembers(standing([
      { organizationId: 'org1', memberUserIds: ['alice'] },
      { organizationId: 'org2', memberUserIds: ['bob'] },
    ]), { seats, disconnectWhere: transport.disconnectWhere })
    // Only the socket admitted for the organization that removed them ends.
    expect(outcome).toEqual({ seatUserIds: [], socketsClosed: 1 })
    expect(transport.open).toEqual([member('bob', 'member', 'org2')])
  })
})
