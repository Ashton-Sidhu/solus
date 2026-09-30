import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { HostOrganization } from '@solus/contracts/uplink'
import type { Principal } from '@solus/server/admission/principal'
import { RpcAccessError, assertRpcAccess } from '@solus/server/admission/access-policy'
import { SeatManager } from '@solus/server/execution/seats/seat-manager'
import { hasLeftOrganization, removeDepartedMembers } from '@solus/server/host/departed-members'
import type { HostStanding } from '@solus/server/host/organizations'
import type { ShareManager as ShareManagerType } from '@solus/server/sharing/share-manager'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

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
    const transport = sockets([member('bob'), member('bob'), member('cara'), { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }])

    const outcome = await removeDepartedMembers(standing([{ organizationId: 'org1', memberUserIds: ['alice', 'cara'] }]), { seats, disconnectWhere: transport.disconnectWhere })

    expect(outcome).toEqual({ seatUserIds: ['bob'], socketsClosed: 2 })
    expect(seats.memberUserIds()).toEqual(['cara'])
    expect(existsSync(bobHome)).toBe(false)
    expect((await seats.status({ kind: 'user', userId: { kind: 'account', accountId: 'cara' } }, 'claude-code')).state).toBe('connected')
    expect(transport.open.map((principal) => principal.kind === 'org-member' ? principal.userId : principal.kind)).toEqual(['cara', 'local-owner'])
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

describe('transferring a departed member\'s resources', () => {
  type ShareManagerModule = typeof import('@solus/server/sharing/share-manager')
  let dataDir: string
  let db: typeof import('@solus/server/db')
  let database: typeof import('@solus/server/db/database')
  let ShareManager: ShareManagerModule['ShareManager']
  let ShareAccessError: ShareManagerModule['ShareAccessError']
  const previousDataDir = process.env.SOLUS_DATA_DIR

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-member-removal-'))
    process.env.SOLUS_DATA_DIR = dataDir
    db = await import('@solus/server/db')
    database = await import('@solus/server/db/database')
    ;({ ShareManager, ShareAccessError } = await import('@solus/server/sharing/share-manager'))
  })
  afterEach(async () => {
    await resetTestDatabase()
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  })
  afterAll(() => {
    db.closeDb()
    rmSync(dataDir, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = previousDataDir
  })

  function manager(current: HostStanding): ShareManagerType {
    return new ShareManager({
      db: database.getDatabase(),
      now: () => 1_000,
      hasLeftOrganization: (organizationId, userId) => hasLeftOrganization(current, organizationId, userId),
    })
  }
  const session = { kind: 'session', id: 's-dave' } as const

  test('a host admin may transfer a departed member\'s session; a member may not', async () => {
    const shares = manager(standing([{ organizationId: 'org1', memberUserIds: ['alice', 'bob', 'cara'] }]))
    await shares.claimOwner(session, member('dave'))
    await expect(shares.transfer({ resource: session, toUserId: 'bob' }, member('bob'))).rejects.toThrow(ShareAccessError)
    const list = await shares.transfer({ resource: session, toUserId: 'cara' }, member('alice', 'owner'))
    expect(list.ownerUserId).toBe('cara')
    expect(await shares.roleFor(member('cara'), session)).toBe('owner')
  })

  test('while the owner is still a member, only they transfer', async () => {
    const shares = manager(standing([{ organizationId: 'org1', memberUserIds: ['alice', 'dave'] }]))
    await shares.claimOwner(session, member('dave'))
    await expect(shares.transfer({ resource: session, toUserId: 'alice' }, member('alice', 'owner'))).rejects.toThrow(ShareAccessError)
  })

  test('the access gate lets a host admin reach the share manager, and still refuses a member', async () => {
    const table = { roleFor: async () => 'editor' as const }
    const args = [{ resource: session, toUserId: 'cara' }]
    await expect(assertRpcAccess('shareTransfer', member('alice', 'owner'), args, table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('shareTransfer', member('bob'), args, table)).rejects.toThrow(RpcAccessError)
  })
})
