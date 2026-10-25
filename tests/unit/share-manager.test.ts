import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { sql } from 'drizzle-orm'
import type { Principal } from '@solus/server/admission/principal'
import type { ShareAccessError as ShareAccessErrorType, ShareChange, ShareManager as ShareManagerType } from '@solus/server/sharing/share-manager'
import { hostUserKey } from '@solus/server/host/host-user'
import { resetTestDatabase } from './helpers/test-db'
import { seedResource } from './helpers/resource-rows'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/access-model.md §2.2–§2.3 and multiplayer-sharing.md §3.4–§3.5: a
// resource's owner is its own row's `owner_key`; the ACL entries hold only what
// the owner gave others — a person, their team, the organization, or the link
// (scope, decision 2026-09-16); a resource made in an organization's space starts
// with the organization's editor entry; an administrator is an editor of what is
// not theirs; the link is one `everyone` entry whose secret the host keeps beside
// its hash and hands only to whoever may share; and a change is announced so
// guests can be dropped. The rows live in the ported schema
// (docs/plans/cloud-service-model.md), so the suite runs on either engine.

type ShareManagerModule = typeof import('@solus/server/sharing/share-manager')
type DbModule = typeof import('@solus/server/db')
type DatabaseModule = typeof import('@solus/server/db/database')

let dataDir: string
let db: DbModule
let database: DatabaseModule
let sharing: ShareManagerModule
let ShareManager: ShareManagerModule['ShareManager']
let ShareAccessError: typeof ShareAccessErrorType
let hashLinkSecret: ShareManagerModule['hashLinkSecret']
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-share-manager-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  database = await import('@solus/server/db/database')
  sharing = await import('@solus/server/sharing/share-manager')
  ;({ ShareManager, ShareAccessError, hashLinkSecret } = sharing)
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

const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }
const REMOTE_OWNER: Principal = { kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const member = (userId: string, teamIds: string[] = [], organizationRole: 'owner' | 'member' = 'member', hostKind: 'personal' | 'managed' | 'cloud' = 'managed', organizationId = 'org1'): Principal => ({
  kind: 'org-member', userId, organizationId, organizationRole, teamIds, hostKind, displayName: userId, deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})

const seed = (kind: 'session' | 'work' | 'task', id: string, ownerKey: string, organizationId = 'local') =>
  seedResource(database.getDatabase(), kind, id, ownerKey, organizationId)

function manager(): { shares: ShareManagerType; changes: ShareChange[] } {
  const changes: ShareChange[] = []
  const shares = new ShareManager({ db: database.getDatabase(), now: () => 1_000 })
  shares.onChanged((change) => changes.push(change))
  return { shares, changes }
}

describe('reach', () => {
  test('a named share is refused on a host members cannot reach; the link is not', async () => {
    // WHY (host-sharing.md §4.3): a member reaches a host through the cloud app, which
    // needs the host linked. A share with the organization on an unlinked host would move
    // the record into an organization nobody can open; the guest link needs no cloud.
    const shares = new ShareManager({ db: database.getDatabase(), membersReachable: () => false })
    const session = { kind: 'session', id: 's1' } as const
    await seed('session', 's1', hostUserKey())
    await expect(shares.setEntries({ resource: session, entries: [{ subject: { kind: 'organization', id: 'org1' }, role: 'editor' }] }, OWNER))
      .rejects.toMatchObject({ code: 'HOST_NOT_LINKED' })
    await expect(shares.setEntries({ resource: session, entries: [], link: { role: 'viewer' } }, OWNER)).resolves.toMatchObject({ link: { role: 'viewer' } })
    expect((await shares.setLink({ resource: session, role: 'editor' }, OWNER))?.role).toBe('editor')
  })
})

describe('ownership', () => {
  test('the creator owns a resource; another member of the organization edits it only through the organization entry', async () => {
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'bob', 'org1')
    expect(await shares.roleFor(member('bob'), work)).toBe('owner')
    expect(await shares.roleFor(member('cara'), work)).toBe('none')
    // Only the owner gives the organization its entry; cara asking changes nothing.
    await shares.shareWithOrganization(work, member('cara'))
    expect(await shares.roleFor(member('cara'), work)).toBe('none')
    await shares.shareWithOrganization(work, member('bob'))
    expect(await shares.roleFor(member('cara'), work)).toBe('editor')
    expect(await shares.roleFor(member('bob'), work)).toBe('owner')
  })

  test('a resource made in an organization space starts shared with the organization; one on a personal host starts private', async () => {
    // WHY: the cloud machine is the team's, so its work is the team's to see until the
    // owner narrows it; a person's own machine shares nothing until they say so.
    const { shares } = manager()
    const cloud = { kind: 'work', id: 'cloud' } as const
    await seed('work', 'cloud', 'bob', 'org1')
    await shares.shareWithOrganization(cloud, member('bob'))
    expect((await shares.list(cloud, member('bob'))).entries).toEqual([
      { subject: { kind: 'organization', id: 'org1' }, role: 'editor', grantedByUserId: 'bob', createdAt: 1_000 },
    ])
    const personal = { kind: 'work', id: 'personal' } as const
    await seed('work', 'personal', 'bob', 'org1')
    await shares.shareWithOrganization(personal, member('bob', [], 'member', 'personal'))
    expect((await shares.list(personal, member('bob', [], 'member', 'personal'))).entries).toEqual([])
    expect(await shares.roleFor(member('cara', [], 'member', 'personal'), personal)).toBe('none')
    // The host owner's own work on their machine is theirs alone until shared.
    const mine = { kind: 'work', id: 'mine' } as const
    await seed('work', 'mine', hostUserKey())
    expect(await shares.roleFor(OWNER, mine)).toBe('owner')
    expect(await shares.roleFor(member('cara', [], 'member', 'personal'), mine)).toBe('none')
  })

  test('a session is its starter\'s before its record exists; a chat starts private and only its owner gives the organization its entry later', async () => {
    // WHY: decision S5 — a chat is its owner's own, so the team does not see it
    // until the owner shares it. A session watched before its folder is known gets
    // the entry only when its owner's prompt names a project folder. The claim is
    // made before the record is written, and the record is born with that owner.
    const { shares } = manager()
    const chat = { kind: 'session', id: 'chat-claimed-before-record' } as const
    await shares.claimSession(chat.id, member('bob'), { shareWithOrganization: false })
    await shares.claimSession(chat.id, member('cara'))
    expect(await shares.roleFor(member('bob'), chat)).toBe('owner')
    expect(await shares.roleFor(member('cara'), chat)).toBe('none')

    await shares.shareWithOrganization(chat, member('cara'))
    expect(await shares.roleFor(member('cara'), chat)).toBe('none')
    await shares.shareWithOrganization(chat, member('bob'))
    expect(await shares.roleFor(member('cara'), chat)).toBe('editor')
  })

  test('the host owner owns what is the host user\'s, local or over the tunnel', async () => {
    const { useHostUser } = await import('@solus/server/host/host-user')
    useHostUser({ localId: 'h1', account: { accountId: 'alice' } })
    try {
      const { shares } = manager()
      const work = { kind: 'work', id: 'w1' } as const
      await seed('work', 'w1', hostUserKey())
      expect(await shares.roleFor(REMOTE_OWNER, work)).toBe('owner')
      expect(await shares.roleFor(OWNER, work)).toBe('owner')
    } finally {
      useHostUser(null)
    }
  })

  test('the personal host owner is an administrator: an editor of a member\'s resource, as a managed-host organization owner is', async () => {
    // WHY (docs/plans/access-model.md §2.5): an administrator gets `editor` on every
    // resource that is not personal, and `owner` only on what they own. This changes
    // the earlier rule, where the host owner held `owner` on the whole disk.
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'bob', 'org1')
    expect(await shares.roleFor(OWNER, work)).toBe('editor')
    expect(await shares.roleFor(member('admin', [], 'owner', 'managed'), work)).toBe('editor')
    expect(await shares.roleFor(member('admin', [], 'owner', 'personal'), work)).toBe('none')
  })

  test('only the owner transfers; the owner key moves and the previous owner is named as removed', async () => {
    const { shares, changes } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'bob', 'org1')
    await shares.shareWithOrganization(work, member('bob'))
    await expect(shares.transfer({ resource: work, toUserId: 'cara' }, member('cara'))).rejects.toThrow(ShareAccessError)
    const list = await shares.transfer({ resource: work, toUserId: 'cara' }, member('bob'))
    expect(list.ownerKey).toBe('cara')
    expect(await database.getDatabase().all(sql`SELECT owner_key FROM works WHERE id = 'w1'`)).toEqual([{ owner_key: 'cara' }])
    // The organization entry still admits bob, as an editor now.
    expect(await shares.roleFor(member('bob'), work)).toBe('editor')
    expect(changes.at(-1)?.removedUserIds).toEqual(['bob'])
  })

  test('a resource of one organization is nothing to a member of another', async () => {
    // WHY: one Postgres serves every organization (docs/plans/cloud-service-model.md).
    // A member reads the records of the organization their grant names.
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    const bob = member('bob', [], 'member', 'cloud', 'org1')
    const eve = member('eve', [], 'member', 'cloud', 'org2')
    await seed('work', 'w1', 'bob', 'org1')
    await shares.setEntries({ resource: work, entries: [{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer' }] }, bob)
    expect(await shares.roleFor(bob, work)).toBe('owner')
    expect(await shares.roleFor(eve, work)).toBe('none')
    expect(await shares.filterVisible(eve, 'work', [{ id: 'w1' }], (row) => row.id)).toEqual([])
    // A listed page carries each reader's role, the same answer `roleFor` gives (access-model.md §2.7).
    expect(await shares.accessOf(bob, 'work', ['w1'])).toEqual(new Map([['w1', { ownerKey: 'bob', role: 'owner' }]]))
    expect(await shares.accessOf(eve, 'work', ['w1'])).toEqual(new Map([['w1', { ownerKey: 'bob', role: 'none' }]]))
    expect((await shares.accessOf(member('dan'), 'work', ['w1'])).get('w1')?.role).toBe('viewer')
    // A member of org1 on a managed host holds what the organization entry gives, and no more.
    expect(await shares.roleFor(member('dan'), work)).toBe('viewer')
  })
})

describe('ACL entries', () => {
  test('a member holds what the entries give: their team, the organization, or nothing', async () => {
    // WHY: the dialog offers a scope (decision 2026-09-16). "Team A" must mean team A
    // and not the whole organization, or the choice would be a lie.
    const { shares } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'alice', 'org1')
    expect(await shares.roleFor(member('bob'), doc)).toBe('none')
    await shares.setEntries({ resource: doc, entries: [{ subject: { kind: 'team', id: 'team-a' }, role: 'editor' }] }, member('alice'))
    expect(await shares.roleFor(member('cara', ['team-a']), doc)).toBe('editor')
    expect(await shares.roleFor(member('dan', ['team-b']), doc)).toBe('none')
    await shares.setEntries({ resource: doc, entries: [
      { subject: { kind: 'organization', id: 'org1' }, role: 'viewer' },
      { subject: { kind: 'team', id: 'team-a' }, role: 'editor' },
    ] }, member('alice'))
    // The highest entry wins; a member of another organization is admitted by none.
    expect(await shares.roleFor(member('cara', ['team-a']), doc)).toBe('editor')
    expect(await shares.roleFor(member('dan', ['team-b']), doc)).toBe('viewer')
    expect(await shares.roleFor(member('eve', [], 'member', 'managed', 'org2'), doc)).toBe('none')
  })

  test('the host\'s own work on a managed host is its user\'s: members reach it through entries, an administrator edits it', async () => {
    // WHY (docs/plans/access-model.md §2.2): every resource has an owner, so the host's
    // own work belongs to the host's user. This changes the earlier rule, where a
    // resource nobody owned on a managed host was every member's to edit.
    const { shares } = manager()
    const doc = { kind: 'work', id: 'automation' } as const
    await seed('work', 'automation', hostUserKey(), 'org1')
    expect(await shares.roleFor(member('bob'), doc)).toBe('none')
    expect(await shares.roleFor(member('admin', [], 'owner'), doc)).toBe('editor')
  })

  test('an editor through an entry may change the list, and removing a named entry takes their standing with it', async () => {
    const { shares } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'alice', 'org1')
    await shares.setEntries({ resource: doc, entries: [
      { subject: { kind: 'user', id: 'bob' }, role: 'editor' },
      { subject: { kind: 'user', id: 'cara' }, role: 'viewer' },
    ] }, member('alice'))
    const list = await shares.setEntries({ resource: doc, entries: [{ subject: { kind: 'user', id: 'cara' }, role: 'editor' }] }, member('bob'))
    expect(list.entries.map((grant) => `${grant.subject.kind}:${'id' in grant.subject ? grant.subject.id : ''}=${grant.role}`)).toEqual(['user:cara=editor'])
    // bob removed his own entry: the write still answers, with the list as it now stands.
    expect(list.callerRole).toBe('none')
    expect(await shares.roleFor(member('bob'), doc)).toBe('none')
    await expect(shares.setEntries({ resource: doc, entries: [] }, member('bob'))).rejects.toThrow(ShareAccessError)
  })

  test('removing a user entry names them in the change so their client can show the notice', async () => {
    const { shares, changes } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'alice', 'org1')
    await shares.setEntries({ resource: doc, entries: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, member('alice'))
    await shares.setEntries({ resource: doc, entries: [] }, member('alice'))
    expect(changes.at(-1)).toMatchObject({ resource: doc, removedUserIds: ['bob'], guestsRevoked: false, changedBy: { id: { kind: 'account', accountId: 'alice' } } })
  })

  test('a listing shows a member what they own and what an entry names them on; an administrator sees everything', async () => {
    // WHY: a sidebar row the member cannot open is a broken promise; a resource they
    // may open must never be missing from it either.
    const { shares } = manager()
    await seed('work', 'mine', 'bob', 'org1')
    await seed('work', 'theirs', 'alice', 'org1')
    await seed('work', 'team', 'alice', 'org1')
    await seed('work', 'hosts', hostUserKey(), 'org1')
    await shares.setEntries({ resource: { kind: 'work', id: 'team' }, entries: [{ subject: { kind: 'team', id: 'team-a' }, role: 'viewer' }] }, member('alice', [], 'member', 'personal'))
    const works = [{ id: 'mine' }, { id: 'theirs' }, { id: 'team' }, { id: 'hosts' }]
    const idOf = (work: { id: string }) => work.id
    expect((await shares.filterVisible(member('bob', ['team-a'], 'member', 'personal'), 'work', works, idOf)).map(idOf)).toEqual(['mine', 'team'])
    expect((await shares.filterVisible(member('bob', [], 'member', 'personal'), 'work', works, idOf)).map(idOf)).toEqual(['mine'])
    expect((await shares.filterVisible(member('bob'), 'work', works, idOf)).map(idOf)).toEqual(['mine'])
    expect(await shares.filterVisible(OWNER, 'work', works, idOf)).toHaveLength(4)
    expect(await shares.filterVisible(member('admin', [], 'owner'), 'work', works, idOf)).toHaveLength(4)
    await expect(shares.list({ kind: 'work', id: 'theirs' }, member('bob', [], 'member', 'personal'))).rejects.toThrow(ShareAccessError)
  })
})

describe('new sessions', () => {
  test('a session the host has never seen is the starter\'s; one it knows is the host user\'s until shared', async () => {
    // WHY: the access check runs before the first request claims ownership, so a
    // member could never start a session on a personal host otherwise. A session
    // the machine knows with no record yet is its own, as its record will say.
    const known = new Set(['old'])
    const shares = new ShareManager({ db: database.getDatabase(), now: () => 1_000, sessionExists: (id) => known.has(id) })
    const bob = member('bob', [], 'member', 'personal')
    expect(await shares.roleFor(bob, { kind: 'session', id: 'fresh-never-seen' })).toBe('owner')
    expect(await shares.roleFor(bob, { kind: 'session', id: 'old' })).toBe('none')
    expect(await shares.roleFor(OWNER, { kind: 'session', id: 'old' })).toBe('owner')
    // Once someone has claimed it, a fresh id is theirs alone.
    await shares.claimSession('fresh-never-seen', member('alice', [], 'member', 'personal'))
    expect(await shares.roleFor(bob, { kind: 'session', id: 'fresh-never-seen' })).toBe('none')
    // Works are never started this way: a work is created with its owner.
    expect(await shares.roleFor(bob, { kind: 'work', id: 'fresh' })).toBe('none')
  })

  test('a session with no owner yet has no share list and takes no entry; it is never made the host user\'s', async () => {
    // WHY: every resource has one owner (docs/plans/access-model.md §2.2). Before
    // its record, the starter may drive it, but a list would have to invent an
    // owner, and an entry would outlive a session that is never recorded.
    const shares = new ShareManager({ db: database.getDatabase(), now: () => 1_000, sessionExists: () => false })
    const bob = member('bob', [], 'member', 'personal')
    const fresh = { kind: 'session', id: 'fresh-unowned' } as const
    expect(await shares.roleFor(bob, fresh)).toBe('owner')
    await expect(shares.list(fresh, bob)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(shares.setEntries({ resource: fresh, entries: [], link: { role: 'viewer' } }, bob)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(shares.setLink({ resource: fresh, role: 'viewer' }, OWNER)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // Claimed, it has an owner, and the list names them.
    await shares.claimSession(fresh.id, bob)
    expect((await shares.list(fresh, bob)).ownerKey).toBe('bob')
  })
})

describe('one decision per check', () => {
  test('a role check reads the resource row and its entries, for everyone', async () => {
    // WHY: every request through the access policy asks for a role, and `roleOf`
    // decides it from the owner on the row and the ACL entries. The host owner
    // reads them too: they own only what is theirs.
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'alice', 'org1')
    await shares.shareWithOrganization(work, member('alice'))
    const asMember = { queries: 0, queryMs: 0 }
    expect(await database.tallyQueries(asMember, () => shares.roleFor(member('bob'), work))).toBe('editor')
    expect(asMember.queries).toBe(2)
    const asOwner = { queries: 0, queryMs: 0 }
    expect(await database.tallyQueries(asOwner, () => shares.roleFor(OWNER, work))).toBe('editor')
    expect(asOwner.queries).toBe(2)
  })

  test('the owner is never an ACL entry', async () => {
    // WHY: the ACL holds only what the owner gave others. An entry for the owner
    // would be a second answer for one person.
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'alice', 'org1')
    const list = await shares.setEntries({ resource: work, entries: [{ subject: { kind: 'user', id: 'alice' }, role: 'viewer' }, { subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, member('alice'))
    expect(list.ownerKey).toBe('alice')
    expect(list.entries.map((grant) => grant.subject)).toEqual([{ kind: 'user', id: 'bob' }])
    const subjects = await database.getDatabase().all<{ subject_id: string }>(sql`SELECT subject_id FROM acl_entry WHERE resource_id = 'w1'`)
    expect(subjects).toEqual([{ subject_id: 'bob' }])
  })

  test('a transfer to a person with a named entry makes them owner and drops that entry', async () => {
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'alice', 'org1')
    await shares.setEntries({ resource: work, entries: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, member('alice'))
    const list = await shares.transfer({ resource: work, toUserId: 'bob' }, member('alice'))
    expect(list.ownerKey).toBe('bob')
    expect(list.entries.some((grant) => grant.subject.kind === 'user' && grant.subject.id === 'bob')).toBe(false)
    expect(await shares.roleFor(member('bob'), work)).toBe('owner')
    expect((await shares.homeOf(work))?.ownerKey).toBe('bob')
  })
})

describe('tasks', () => {
  const cloud = (userId: string) => member(userId, [], 'member', 'cloud')

  test('a task is its organization\'s and is not shared on its own; what is linked to it keeps its own access', async () => {
    // WHY: a task is born with its organization's entry. If a session or work took
    // access from a task it is linked to, linking it would silently open it to the
    // whole organization (decision 2026-10-06). Each resource is shared on its own.
    const { shares } = manager()
    await seed('task', 't1', 'alice', 'org1')
    await seed('session', 's1', 'alice', 'org1')
    await shares.shareWithOrganization({ kind: 'task', id: 't1' }, cloud('alice'))
    expect(await shares.roleFor(cloud('bob'), { kind: 'task', id: 't1' })).toBe('editor')
    expect(await shares.roleFor(cloud('bob'), { kind: 'session', id: 's1' })).toBe('none')
    expect((await shares.filterVisible(cloud('bob'), 'session', [{ id: 's1' }], (session) => session.id))).toEqual([])
    await expect(shares.setEntries({ resource: { kind: 'task', id: 't1' }, entries: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, cloud('alice'))).rejects.toThrow(ShareAccessError)
    await expect(shares.setLink({ resource: { kind: 'task', id: 't1' }, role: 'viewer' }, cloud('alice'))).rejects.toThrow(ShareAccessError)
  })

  test('a guest bound to a task reaches nothing', async () => {
    const { shares } = manager()
    await seed('task', 't1', 'alice', 'org1')
    await seed('session', 's1', 'alice', 'org1')
    // A guest from a task link made before tasks stopped being shared opens nothing.
    const maya: Principal = {
      kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', organizationId: 'org1',
      share: { resource: { kind: 'task', id: 't1' }, role: 'editor', sharedByUserId: 'alice', linkSecretHash: 'legacy' },
      expiresAt: 0, deviceLabel: 'Guest link',
    }
    expect(await shares.roleFor(maya, { kind: 'task', id: 't1' })).toBe('none')
    expect(await shares.filterVisible(maya, 'session', [{ id: 's1' }], (session) => session.id)).toEqual([])
  })
})

describe('the link and guests', () => {
  // A guest's ticket carries the organization the link resolved to: the member's own.
  const guest = (secretHash: string, role: 'viewer' | 'editor' = 'viewer'): Principal => ({
    kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', organizationId: 'org1',
    share: { resource: { kind: 'session', id: 's1' }, role, sharedByUserId: 'alice', linkSecretHash: secretHash },
    expiresAt: 0, deviceLabel: 'Guest link',
  })

  test('the secret admits by its hash and resolves to one resource and role', async () => {
    const { shares } = manager()
    const session = { kind: 'session', id: 's1' } as const
    await seed('session', 's1', 'alice', 'org1')
    const link = (await shares.setLink({ resource: session, role: 'viewer' }, member('alice')))!
    expect(link.secret.length).toBeGreaterThan(30)
    // The entry carries its resource's organization (organization-scope §3): the link a guest is admitted by names it.
    expect(await shares.resolveLinkSecret(link.secret)).toEqual({ organizationId: 'org1', resource: session, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: hashLinkSecret(link.secret) })
    expect(await shares.resolveLinkSecret('nope')).toBeNull()
    expect((await shares.list(session, member('alice'))).link).toEqual({ role: 'viewer', secret: link.secret })
    // Changing the role keeps the secret, and the answer is the link as it now stands.
    expect(await shares.setLink({ resource: session, role: 'editor' }, member('alice'))).toEqual({ role: 'editor', secret: link.secret })
    expect((await shares.resolveLinkSecret(link.secret))?.role).toBe('editor')
  })

  test('a link opens in one read that answers every role as roleFor does, and names the runner', async () => {
    // WHY (instant-share-open.md §4.4): the resolve waits on the database once, so its
    // one read must give the same role as every gate, or a link would open a member
    // as more, or less, than the record lets them.
    const { shares } = manager()
    const session = { kind: 'session', id: 's1' } as const
    await seed('session', 's1', 'alice', 'org1')
    await database.getDatabase().run(sql`UPDATE session_records SET runner_host_id = 'host-a' WHERE session_id = 's1'`)
    await shares.setEntries({ resource: session, entries: [{ subject: { kind: 'team', id: 'web' }, role: 'editor' }, { subject: { kind: 'user', id: 'carol' }, role: 'viewer' }] }, member('alice'))
    const link = (await shares.setLink({ resource: session, role: 'viewer' }, member('alice')))!
    const opened = (await shares.openLink(link.secret))!
    expect(opened.share).toEqual((await shares.resolveLinkSecret(link.secret))!)
    expect(opened.runnerHostId).toBe('host-a')
    for (const principal of [member('alice'), member('bob', ['web']), member('carol'), member('dave'), member('erin', [], 'owner'), member('bob', ['web'], 'member', 'managed', 'org2')]) {
      expect(opened.roleOf(principal)).toBe(await shares.roleFor(principal, session))
    }
    expect(await shares.openLink('nope')).toBeNull()

    await seed('work', 'w1', 'alice', 'org1')
    const workLink = (await shares.setLink({ resource: { kind: 'work', id: 'w1' }, role: 'editor' }, member('alice')))!
    const work = (await shares.openLink(workLink.secret))!
    expect(work.runnerHostId).toBeNull()
    expect(work.roleOf(member('alice'))).toBe('owner')
  })

  test('a guest is bound to its resource and loses access the moment the link is regenerated or removed', async () => {
    const { shares, changes } = manager()
    const session = { kind: 'session', id: 's1' } as const
    await seed('session', 's1', 'alice', 'org1')
    await seed('session', 's2', 'alice', 'org1')
    await seed('work', 'w1', 'alice', 'org1')
    const link = (await shares.setLink({ resource: session, role: 'viewer' }, member('alice')))!
    const maya = guest(hashLinkSecret(link.secret))
    expect(await shares.roleFor(maya, session)).toBe('viewer')
    expect(await shares.roleFor(maya, { kind: 'session', id: 's2' })).toBe('none')
    const idOf = (row: { id: string }) => row.id
    expect((await shares.filterVisible(maya, 'session', [{ id: 's1' }, { id: 's2' }], idOf)).map(idOf)).toEqual(['s1'])
    expect(await shares.filterVisible(maya, 'work', [{ id: 'w1' }], idOf)).toEqual([])

    const rotated = (await shares.setLink({ resource: session, role: 'viewer', regenerate: true }, member('alice')))!
    expect(rotated.secret).not.toBe(link.secret)
    expect(await shares.roleFor(maya, session)).toBe('none')
    expect(changes.at(-1)?.guestsRevoked).toBe(true)

    await shares.setLink({ resource: session, role: null }, member('alice'))
    expect(await shares.resolveLinkSecret(rotated.secret)).toBeNull()
    expect(changes.at(-1)?.guestsRevoked).toBe(true)
  })

  test('the link is always at hand for the owner and members, never for a viewing guest, and survives a role change', async () => {
    // WHY: a share control is only useful when the link can be copied any time; a
    // viewer must never be handed the secret through the list.
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    await seed('work', 'w1', 'alice', 'org1')
    await shares.shareWithOrganization(work, member('alice'))
    const link = (await shares.setLink({ resource: work, role: 'viewer' }, member('alice')))!
    expect((await shares.list(work, member('alice'))).link).toEqual({ role: 'viewer', secret: link.secret })
    expect((await shares.list(work, member('bob'))).link).toEqual({ role: 'viewer', secret: link.secret })
    const viewingGuest: Principal = {
      kind: 'guest', guestId: 'g2', displayName: 'Vee', deviceId: 'g2', organizationId: 'org1',
      share: { resource: work, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: hashLinkSecret(link.secret) },
      expiresAt: 0, deviceLabel: 'Guest link',
    }
    expect((await shares.list(work, viewingGuest)).link).toEqual({ role: 'viewer' })
    expect(await shares.setLink({ resource: work, role: 'editor' }, member('alice'))).toEqual({ role: 'editor', secret: link.secret })
    expect((await shares.list(work, member('alice'))).link).toEqual({ role: 'editor', secret: link.secret })
    // An entry made before the host kept the secret answers that a link exists, and no more.
    const { aclEntry } = await import('@solus/server/sharing/schema')
    await database.getDatabase().run(sql`
      UPDATE ${aclEntry} SET link_secret = NULL WHERE resource_kind = 'work' AND resource_id = 'w1' AND subject_kind = 'everyone'
    `)
    expect((await shares.list(work, member('alice'))).link).toEqual({ role: 'editor' })
  })

  test('a member never holds less than the link: the host raises or makes the organization entry', async () => {
    // WHY: the link entry admits only guests; a member reaches the resource through the
    // organization's entry. A dialog that raised the link to editor and left the
    // organization at viewer made members read only where a stranger with the link
    // could edit. The host holds the rule, so no client can store that again.
    const { shares } = manager()
    const session = { kind: 'session', id: 's1' } as const
    await seed('session', 's1', 'alice', 'org1')
    await shares.setEntries({ resource: session, entries: [{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer' }] }, member('alice'))

    // Through setLink: the organization is raised with the link.
    await shares.setLink({ resource: session, role: 'editor' }, member('alice'))
    expect(await shares.roleFor(member('bob'), session)).toBe('editor')

    // Through setEntries: a request that lowers the organization below the link is held at it.
    const list = await shares.setEntries({ resource: session, entries: [{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer' }] }, member('alice'))
    expect(list.entries).toMatchObject([{ subject: { kind: 'organization', id: 'org1' }, role: 'editor' }])

    // A link on a resource with no organization entry makes one at the link's role.
    await seed('session', 's2', 'alice', 'org1')
    const second = { kind: 'session', id: 's2' } as const
    await shares.setEntries({ resource: second, entries: [], link: { role: 'editor' } }, member('alice'))
    expect(await shares.roleFor(member('bob'), second)).toBe('editor')

    // A higher organization role stays when the link is lower.
    await seed('session', 's3', 'alice', 'org1')
    const third = { kind: 'session', id: 's3' } as const
    await shares.setEntries({ resource: third, entries: [{ subject: { kind: 'organization', id: 'org1' }, role: 'editor' }], link: { role: 'viewer' } }, member('alice'))
    expect(await shares.roleFor(member('bob'), third)).toBe('editor')
  })

  test('a Local record\'s link names no organization, and an unreachable host gets no entry', async () => {
    // WHY: a link moves nothing into an organization (host-sharing.md §2), and on a host
    // members cannot reach an organization entry would admit nobody (§4.3).
    const { shares } = manager()
    await seed('session', 's-local', 'alice')
    await shares.setLink({ resource: { kind: 'session', id: 's-local' }, role: 'editor' }, OWNER)
    expect((await shares.list({ kind: 'session', id: 's-local' }, OWNER)).entries).toEqual([])

    const unreachable = new ShareManager({ db: database.getDatabase(), membersReachable: () => false })
    await seed('session', 's-org', 'alice', 'org1')
    await unreachable.setLink({ resource: { kind: 'session', id: 's-org' }, role: 'editor' }, member('alice'))
    expect((await unreachable.list({ kind: 'session', id: 's-org' }, member('alice'))).entries).toEqual([])
  })

  test('a session is shared by its session id alone; a provider thread id names no session', async () => {
    // WHY: one session id (docs/plans/session-identity.md). An entry keyed by a
    // thread id would give access to a session nobody shared under its own id.
    const { shares } = manager()
    await seed('session', 's1', 'alice', 'org1')
    expect(await shares.roleFor(member('alice'), { kind: 'session', id: 's1' })).toBe('owner')
    expect(await shares.homeOf({ kind: 'session', id: 'thread-1' })).toBeNull()
  })
})

describe('sharing a Local record with an organization', () => {
  // WHY: a member is admitted only to records of their own organization
  // (organization-scope §3). Sharing a Local session from this machine with
  // "everyone in org1" must put the session in org1, or no member of org1 could
  // open it. A record of another organization never moves.
  const session = { kind: 'session' as const, id: 's-local' }
  const orgOf = (rows: Array<{ organization_id: string }>) => [...new Set(rows.map((row) => row.organization_id))]
  const entriesOf = async (id: string) => database.getDatabase().all<{ organization_id: string }>(sql`SELECT organization_id FROM acl_entry WHERE resource_id = ${id}`)

  function withAssignment() {
    const assigned: Array<[string, string]> = []
    const shares = new ShareManager({
      db: database.getDatabase(),
      now: () => 1_000,
      // The one-time move from Local, as `assignSessionOrganization` makes it.
      assignOrganization: async (resource, organizationId) => {
        const home = await shares.homeOf(resource)
        if (!home) return null
        if (home.organizationId !== 'local') return home.organizationId
        assigned.push([resource.id, organizationId])
        await database.getDatabase().run(sql`UPDATE session_records SET organization_id = ${organizationId} WHERE session_id = ${resource.id}`)
        return organizationId
      },
    })
    return { shares, assigned }
  }

  test('the record joins the organization, its Local entries follow, and its members can open it', async () => {
    const { shares, assigned } = withAssignment()
    await seed('session', 's-local', hostUserKey())
    await shares.setLink({ resource: session, role: 'viewer' }, OWNER)
    expect(orgOf(await entriesOf('s-local'))).toEqual(['local'])

    await shares.setEntries({ resource: session, entries: [{ subject: { kind: 'organization', id: 'org1' }, role: 'editor' }] }, OWNER)

    expect(assigned).toEqual([['s-local', 'org1']])
    expect(orgOf(await entriesOf('s-local'))).toEqual(['org1'])
    expect(await shares.roleFor(member('bob', [], 'member', 'personal'), session)).toBe('editor')
    expect(await shares.roleFor(member('carol', [], 'member', 'personal', 'org2'), session)).toBe('none')
    expect(await shares.roleFor(OWNER, session)).toBe('owner')
  })

  test('a record of another organization is refused and nothing is written', async () => {
    const { shares, assigned } = withAssignment()
    const other = { kind: 'session' as const, id: 's-org2' }
    await seed('session', 's-org2', hostUserKey(), 'org2')

    await expect(shares.setEntries({ resource: other, entries: [{ subject: { kind: 'organization', id: 'org1' }, role: 'editor' }] }, OWNER)).rejects.toBeInstanceOf(ShareAccessError)

    expect(assigned).toEqual([])
    expect(await entriesOf('s-org2')).toEqual([])
  })

  test('a host that cannot assign the record refuses instead of writing an entry nobody can use', async () => {
    const { shares } = manager()
    await seed('session', 's-local', hostUserKey())
    await shares.setLink({ resource: session, role: 'viewer' }, OWNER)
    await expect(shares.setEntries({ resource: session, entries: [{ subject: { kind: 'organization', id: 'org1' }, role: 'editor' }] }, OWNER)).rejects.toBeInstanceOf(ShareAccessError)
    expect(orgOf(await entriesOf('s-local'))).toEqual(['local'])
  })

  test('a record assigned by another path takes its Local entries with it, and no other organization\'s', async () => {
    const { shares } = manager()
    await seed('session', 's-local', hostUserKey())
    await shares.setLink({ resource: session, role: 'viewer' }, OWNER)
    await shares.followRecordOrganization(session, 'org1')
    expect(orgOf(await entriesOf('s-local'))).toEqual(['org1'])
    await shares.followRecordOrganization(session, 'org2')
    expect(orgOf(await entriesOf('s-local'))).toEqual(['org1'])
  })
})
