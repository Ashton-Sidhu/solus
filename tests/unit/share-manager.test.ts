import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import type { Principal } from '@solus/server/server/principal'
import type { ShareAccessError as ShareAccessErrorType, ShareChange, ShareManager as ShareManagerType } from '@solus/server/sharing/share-manager'
import { HOST_OWNER_USER_ID, type ShareResource } from '@solus/contracts/sharing'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/multiplayer-sharing.md §3.4–§3.5: the creator owns a resource; the
// personal host's owner has every role; a member holds what the rows give them —
// their team, the organization, or the link (scope, decision 2026-09-16), and a
// managed host's resources start shared with the organization; the link is one
// `everyone` row whose secret the host keeps beside its hash and hands only to
// whoever may share; and a change is announced so guests can be dropped.
// The rows live in the ported schema (docs/plans/cloud-service-model.md), so the
// suite runs on either engine.

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

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const REMOTE_OWNER: Principal = { kind: 'remote-owner', userId: 'alice', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const member = (userId: string, teamIds: string[] = [], organizationRole: 'owner' | 'member' = 'member', hostKind: 'personal' | 'managed' | 'cloud' = 'managed', organizationId = 'org1'): Principal => ({
  kind: 'org-member', userId, organizationId, organizationRole, teamIds, hostKind, displayName: userId, deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})

/** A task tree in one line: task id → what is linked under it. */
type TaskTree = Record<string, ShareResource[]>

function manager(canonical?: (id: string) => string, tasks: TaskTree = {}): { shares: ShareManagerType; changes: ShareChange[] } {
  const changes: ShareChange[] = []
  const shares = new ShareManager({
    db: database.getDatabase(),
    canonicalSessionId: canonical,
    now: () => 1_000,
    taskContents: async (_organizationId, taskId) => tasks[taskId] ?? [],
    containingTasks: async (_organizationId, resource) => Object.entries(tasks)
      .filter(([, contents]) => contents.some((item) => item.kind === resource.kind && item.id === resource.id))
      .map(([taskId]) => ({ taskId, title: `Task ${taskId}` })),
  })
  shares.onChanged((change) => changes.push(change))
  return { shares, changes }
}

describe('ownership', () => {
  test('the first principal to claim a resource owns it; later claims change nothing', async () => {
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    expect(await shares.claimOwner(work, member('bob'))).toBe('bob')
    expect(await shares.claimOwner(work, member('cara'))).toBe('bob')
    expect(await shares.roleFor(member('bob'), work)).toBe('owner')
    // Cara is in the organization the managed host serves: an editor, never the owner.
    expect(await shares.roleFor(member('cara'), work)).toBe('editor')
  })

  test('a managed host starts a resource shared with the organization; a personal host starts it private', async () => {
    // WHY: the cloud machine is the team's, so its work is the team's to see until the
    // owner narrows it; a person's own machine shares nothing until they say so.
    const { shares } = manager()
    const cloud = { kind: 'work', id: 'cloud' } as const
    await shares.claimOwner(cloud, member('bob'))
    expect((await shares.list(cloud, member('bob'))).grants).toEqual([
      { subject: { kind: 'organization', id: 'org1' }, role: 'editor', grantedByUserId: 'bob', createdAt: 1_000 },
    ])
    const personal = { kind: 'work', id: 'personal' } as const
    await shares.claimOwner(personal, member('bob', [], 'member', 'personal'))
    expect((await shares.list(personal, member('bob', [], 'member', 'personal'))).grants).toEqual([])
    expect(await shares.roleFor(member('cara', [], 'member', 'personal'), personal)).toBe('none')
    // The host owner's own work on their machine is theirs alone until shared.
    const mine = { kind: 'work', id: 'mine' } as const
    await shares.claimOwner(mine, OWNER)
    expect(await shares.roleFor(member('cara', [], 'member', 'personal'), mine)).toBe('none')
  })

  test('a resource made over a local connection is owned by the host owner, whom a remote owner also is', async () => {
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    expect(await shares.claimOwner(work, OWNER)).toBe(HOST_OWNER_USER_ID)
    expect(await shares.roleFor(REMOTE_OWNER, work)).toBe('owner')
    expect(await shares.roleFor(OWNER, work)).toBe('owner')
  })

  test('the personal host owner has every role on a member-owned resource; a managed-host organization owner is an editor like any member', async () => {
    // WHY: the owner owns the disk; on a managed host nobody does (§3.4, §13).
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    await shares.claimOwner(work, member('bob'))
    expect(await shares.roleFor(OWNER, work)).toBe('owner')
    expect(await shares.roleFor(member('admin', [], 'owner', 'managed'), work)).toBe('editor')
  })

  test('only the owner transfers; the previous owner is named as removed', async () => {
    const { shares, changes } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    await shares.claimOwner(work, member('bob'))
    await expect(shares.transfer({ resource: work, toUserId: 'cara' }, member('cara'))).rejects.toThrow(ShareAccessError)
    const list = await shares.transfer({ resource: work, toUserId: 'cara' }, member('bob'))
    expect(list.ownerUserId).toBe('cara')
    // The organization row from the claim still admits bob, as an editor now.
    expect(await shares.roleFor(member('bob'), work)).toBe('editor')
    expect(changes.at(-1)?.removedUserIds).toEqual(['bob'])
  })

  test('rows belong to the organization of the principal that wrote them; another organization in the cloud sees nothing', async () => {
    // WHY: one Postgres serves every organization (docs/plans/cloud-service-model.md).
    // A cloud member reads the rows of the organization their grant names; a
    // host's own rows are `local`, so a managed host's members and its owner agree.
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    const bob = member('bob', [], 'member', 'cloud', 'org1')
    const eve = member('eve', [], 'member', 'cloud', 'org2')
    expect(await shares.claimOwner(work, bob)).toBe('bob')
    await shares.setGrants({ resource: work, grants: [{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer' }] }, bob)
    expect(await shares.roleFor(bob, work)).toBe('owner')
    expect(await shares.roleFor(eve, work)).toBe('none')
    // A resource id names one row (ids are unique across the database): a claim
    // from another organization changes nothing and gives it nothing.
    expect(await shares.claimOwner(work, eve)).toBeNull()
    expect(await shares.roleFor(eve, work)).toBe('none')
    expect(await shares.visibleIds(eve, 'work')).toEqual(new Set())
    expect(await shares.roleFor(bob, work)).toBe('owner')
    // The host's own rows are `local`: a managed-host member reads none of the cloud's.
    expect(await shares.ownerOf('local', work)).toBeNull()
    expect(await shares.roleFor(member('dan'), work)).toBe('editor')
  })
})

describe('share rows', () => {
  test('a member holds what the rows give: their team, the organization, or nothing', async () => {
    // WHY: the dialog offers a scope (decision 2026-09-16). "Team A" must mean team A
    // and not the whole organization, or the choice would be a lie.
    const { shares } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    await shares.claimOwner(doc, member('alice', [], 'member', 'personal'))
    expect(await shares.roleFor(member('bob'), doc)).toBe('none')
    await shares.setGrants({ resource: doc, grants: [{ subject: { kind: 'team', id: 'team-a' }, role: 'editor' }] }, member('alice'))
    expect(await shares.roleFor(member('cara', ['team-a']), doc)).toBe('editor')
    expect(await shares.roleFor(member('dan', ['team-b']), doc)).toBe('none')
    await shares.setGrants({ resource: doc, grants: [
      { subject: { kind: 'organization', id: 'org1' }, role: 'viewer' },
      { subject: { kind: 'team', id: 'team-a' }, role: 'editor' },
    ] }, member('alice'))
    // The highest row wins; a member of another organization is admitted by none.
    expect(await shares.roleFor(member('cara', ['team-a']), doc)).toBe('editor')
    expect(await shares.roleFor(member('dan', ['team-b']), doc)).toBe('viewer')
    expect(await shares.roleFor(member('eve', [], 'member', 'managed', 'org2'), doc)).toBe('none')
  })

  test('the host\'s own unowned work on a managed host is the team\'s to edit; on a personal host it is the owner\'s alone', async () => {
    const { shares } = manager()
    const doc = { kind: 'work', id: 'automation' } as const
    expect(await shares.roleFor(member('bob'), doc)).toBe('editor')
    expect(await shares.roleFor(member('bob', [], 'member', 'personal'), doc)).toBe('none')
  })

  test('an editor through a row may change the list, and removing a named row takes their standing with it', async () => {
    const { shares } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    await shares.claimOwner(doc, member('alice'))
    await shares.setGrants({ resource: doc, grants: [
      { subject: { kind: 'user', id: 'bob' }, role: 'editor' },
      { subject: { kind: 'user', id: 'cara' }, role: 'viewer' },
    ] }, member('alice'))
    const list = await shares.setGrants({ resource: doc, grants: [{ subject: { kind: 'user', id: 'cara' }, role: 'editor' }] }, member('bob'))
    expect(list.grants.map((grant) => `${grant.subject.kind}:${'id' in grant.subject ? grant.subject.id : ''}=${grant.role}`)).toEqual(['user:cara=editor'])
    // bob removed his own row: the write still answers, with the list as it now stands.
    expect(list.callerRole).toBe('none')
    expect(await shares.roleFor(member('bob'), doc)).toBe('none')
    await expect(shares.setGrants({ resource: doc, grants: [] }, member('bob'))).rejects.toThrow(ShareAccessError)
  })

  test('removing a user row names them in the change so their client can show the notice', async () => {
    const { shares, changes } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    await shares.claimOwner(doc, member('alice'))
    await shares.setGrants({ resource: doc, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, member('alice'))
    await shares.setGrants({ resource: doc, grants: [] }, member('alice'))
    expect(changes.at(-1)).toMatchObject({ resource: doc, removedUserIds: ['bob'], guestsRevoked: false, changedBy: { userId: 'alice' } })
  })

  test('a listing shows a member what they own, what a row names them on, and the host\'s own work on a managed host', async () => {
    // WHY: a sidebar row the member cannot open is a broken promise; a resource they
    // may open must never be missing from it either.
    const { shares } = manager()
    await shares.claimOwner({ kind: 'work', id: 'mine' }, member('bob', [], 'member', 'personal'))
    await shares.claimOwner({ kind: 'work', id: 'theirs' }, member('alice', [], 'member', 'personal'))
    await shares.claimOwner({ kind: 'work', id: 'team' }, member('alice', [], 'member', 'personal'))
    await shares.setGrants({ resource: { kind: 'work', id: 'team' }, grants: [{ subject: { kind: 'team', id: 'team-a' }, role: 'viewer' }] }, member('alice', [], 'member', 'personal'))
    const works = [{ id: 'mine' }, { id: 'theirs' }, { id: 'team' }, { id: 'unowned' }]
    const idOf = (work: { id: string }) => work.id
    expect((await shares.filterVisible(member('bob', ['team-a'], 'member', 'personal'), 'work', works, idOf)).map(idOf)).toEqual(['mine', 'team'])
    expect((await shares.filterVisible(member('bob', [], 'member', 'personal'), 'work', works, idOf)).map(idOf)).toEqual(['mine'])
    // On a managed host the unowned work is the host's own, and the team's to see.
    expect((await shares.filterVisible(member('bob'), 'work', works, idOf)).map(idOf)).toEqual(['mine', 'unowned'])
    expect(await shares.filterVisible(OWNER, 'work', works, idOf)).toHaveLength(4)
    await expect(shares.list({ kind: 'work', id: 'theirs' }, member('bob', [], 'member', 'personal'))).rejects.toThrow(ShareAccessError)
  })
})

describe('new sessions', () => {
  test('a session the host has never seen is the starter\'s; one it knows stays closed until shared', async () => {
    // WHY: the access check runs before the first prompt claims ownership, so a
    // member could never start a session on a personal host otherwise.
    const known = new Set(['old'])
    const shares = new ShareManager({ db: database.getDatabase(), now: () => 1_000, sessionExists: (id) => known.has(id) })
    const bob = member('bob', [], 'member', 'personal')
    expect(await shares.roleFor(bob, { kind: 'session', id: 'fresh' })).toBe('owner')
    expect(await shares.roleFor(bob, { kind: 'session', id: 'old' })).toBe('none')
    // Once someone has claimed it, a fresh id is theirs alone.
    await shares.claimOwner({ kind: 'session', id: 'fresh' }, member('alice', [], 'member', 'personal'))
    expect(await shares.roleFor(bob, { kind: 'session', id: 'fresh' })).toBe('none')
    // Works are never started this way: a work is created, and creation claims it.
    expect(await shares.roleFor(bob, { kind: 'work', id: 'fresh' })).toBe('none')
  })
})

describe('tasks', () => {
  const personal = (userId: string, teamIds: string[] = []) => member(userId, teamIds, 'member', 'personal')
  const tree: TaskTree = { t1: [{ kind: 'session', id: 's1' }, { kind: 'work', id: 'w1' }], t2: [{ kind: 'session', id: 's9' }] }

  test('a task shared with someone shares its sessions and works at the task\'s role, short of ownership', async () => {
    // WHY: "share everything in the task" is the promise; the task page alone
    // would be a list of doors that do not open.
    const { shares } = manager(undefined, tree)
    await shares.claimOwner({ kind: 'task', id: 't1' }, personal('alice'))
    await shares.claimOwner({ kind: 'session', id: 's1' }, personal('alice'))
    expect(await shares.roleFor(personal('bob'), { kind: 'session', id: 's1' })).toBe('none')
    await shares.setGrants({ resource: { kind: 'task', id: 't1' }, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, personal('alice'))
    expect(await shares.roleFor(personal('bob'), { kind: 'task', id: 't1' })).toBe('viewer')
    expect(await shares.roleFor(personal('bob'), { kind: 'session', id: 's1' })).toBe('viewer')
    expect(await shares.roleFor(personal('bob'), { kind: 'work', id: 'w1' })).toBe('viewer')
    expect(await shares.roleFor(personal('bob'), { kind: 'session', id: 's9' })).toBe('none')
    // The session's own row still wins when it is higher.
    await shares.setGrants({ resource: { kind: 'session', id: 's1' }, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'editor' }] }, personal('alice'))
    expect(await shares.roleFor(personal('bob'), { kind: 'session', id: 's1' })).toBe('editor')
    // The task's owner edits, but never owns, a session someone else started in it.
    await shares.transfer({ resource: { kind: 'task', id: 't1' }, toUserId: 'cara' }, personal('alice'))
    expect(await shares.roleFor(personal('cara'), { kind: 'session', id: 's1' })).toBe('editor')
    // The session's list names the task it is shared through.
    expect((await shares.list({ kind: 'session', id: 's1' }, personal('alice'))).inheritedFrom).toEqual([{ taskId: 't1', title: 'Task t1' }])
  })

  test('a listing shows what a shared task holds, and a guest on a task reaches exactly its contents', async () => {
    const { shares } = manager(undefined, tree)
    await shares.claimOwner({ kind: 'task', id: 't1' }, personal('alice'))
    await shares.setGrants({ resource: { kind: 'task', id: 't1' }, grants: [{ subject: { kind: 'team', id: 'team-a' }, role: 'viewer' }] }, personal('alice'))
    const sessions = [{ id: 's1' }, { id: 's9' }]
    expect((await shares.filterVisible(personal('bob', ['team-a']), 'session', sessions, (s) => s.id)).map((s) => s.id)).toEqual(['s1'])
    expect(await shares.filterVisible(personal('bob'), 'session', sessions, (s) => s.id)).toEqual([])
    expect((await shares.filterVisible(personal('bob', ['team-a']), 'task', [{ id: 't1' }, { id: 't2' }], (t) => t.id)).map((t) => t.id)).toEqual(['t1'])

    const link = (await shares.setLink({ resource: { kind: 'task', id: 't1' }, role: 'editor' }, personal('alice')))!
    const maya: Principal = {
      kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1',
      share: { resource: { kind: 'task', id: 't1' }, role: 'editor', sharedByUserId: 'alice', linkSecretHash: hashLinkSecret(link.secret) },
      expiresAt: 0, deviceLabel: 'Guest link',
    }
    expect(await shares.roleFor(maya, { kind: 'task', id: 't1' })).toBe('editor')
    expect(await shares.roleFor(maya, { kind: 'session', id: 's1' })).toBe('editor')
    expect(await shares.roleFor(maya, { kind: 'work', id: 'w1' })).toBe('editor')
    expect(await shares.roleFor(maya, { kind: 'session', id: 's9' })).toBe('none')
    expect(await shares.visibleIds(maya, 'session')).toEqual(new Set(['s1']))
    expect(await shares.visibleIds(maya, 'task')).toEqual(new Set(['t1']))
    await shares.setLink({ resource: { kind: 'task', id: 't1' }, role: null }, personal('alice'))
    expect(await shares.roleFor(maya, { kind: 'session', id: 's1' })).toBe('none')
  })

  // The file is the store only on SQLite; on Postgres no hand-made table exists.
  test.skipIf(process.env.SOLUS_DB === 'postgres')('a share table made before tasks could be shared is rebuilt with its rows and its indexes', async () => {
    // WHY: SQLite cannot widen a CHECK; without the rebuild every task share would be refused on an older host.
    await resetTestDatabase()
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
    const legacy = new Database(join(dataDir, 'solus.db'))
    legacy.exec(`
      PRAGMA user_version = 1000;
      CREATE TABLE resource_owner (resource_kind TEXT NOT NULL CHECK (resource_kind IN ('session', 'work')), resource_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (resource_kind, resource_id));
      CREATE TABLE share_grant (id TEXT PRIMARY KEY, resource_kind TEXT NOT NULL CHECK (resource_kind IN ('session', 'work')), resource_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, link_secret_hash TEXT, granted_by_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (resource_kind, resource_id, subject_kind, subject_id));
      CREATE INDEX IF NOT EXISTS share_grant_resource_idx ON share_grant(resource_kind, resource_id);
      INSERT INTO resource_owner VALUES ('work', 'w1', 'alice', 1);
      INSERT INTO share_grant VALUES ('g1', 'work', 'w1', 'user', 'bob', 'viewer', NULL, 'alice', 1);
    `)
    legacy.close()

    const { shares } = manager()
    expect(await shares.roleFor(member('bob', [], 'member', 'personal'), { kind: 'work', id: 'w1' })).toBe('viewer')
    expect(await shares.claimOwner({ kind: 'task', id: 't1' }, member('alice', [], 'member', 'personal'))).toBe('alice')
    const file = db.getDb()
    const indexes = (file.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'share_grant'").all() as { name: string }[]).map((row) => row.name)
    expect(indexes).toContain('share_grant_resource_idx')
    expect(file.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_before_tasks'").all()).toEqual([])
    // The table made before the host kept link secrets gained the column with its rows intact.
    expect((file.prepare("SELECT name FROM pragma_table_info('share_grant')").all() as { name: string }[]).map((row) => row.name)).toContain('link_secret')
    expect((await shares.list({ kind: 'work', id: 'w1' }, member('alice', [], 'member', 'personal'))).grants).toHaveLength(1)
  })
})

describe('the link and guests', () => {
  const guest = (secretHash: string, role: 'viewer' | 'editor' = 'viewer'): Principal => ({
    kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1',
    share: { resource: { kind: 'session', id: 's1' }, role, sharedByUserId: 'alice', linkSecretHash: secretHash },
    expiresAt: 0, deviceLabel: 'Guest link',
  })

  test('the secret admits by its hash and resolves to one resource and role', async () => {
    const { shares } = manager()
    const session = { kind: 'session', id: 's1' } as const
    await shares.claimOwner(session, member('alice'))
    const link = (await shares.setLink({ resource: session, role: 'viewer' }, member('alice')))!
    expect(link.secret.length).toBeGreaterThan(30)
    expect(await shares.resolveLinkSecret(link.secret)).toEqual({ organizationId: 'local', resource: session, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: hashLinkSecret(link.secret) })
    expect(await shares.resolveLinkSecret('nope')).toBeNull()
    expect((await shares.list(session, member('alice'))).link).toEqual({ role: 'viewer', secret: link.secret })
    // Changing the role keeps the secret: no new secret comes back.
    expect(await shares.setLink({ resource: session, role: 'editor' }, member('alice'))).toBeNull()
    expect((await shares.resolveLinkSecret(link.secret))?.role).toBe('editor')
  })

  test('a guest is bound to its resource and loses access the moment the link is regenerated or removed', async () => {
    const { shares, changes } = manager()
    const session = { kind: 'session', id: 's1' } as const
    await shares.claimOwner(session, member('alice'))
    const link = (await shares.setLink({ resource: session, role: 'viewer' }, member('alice')))!
    const maya = guest(hashLinkSecret(link.secret))
    expect(await shares.roleFor(maya, session)).toBe('viewer')
    expect(await shares.roleFor(maya, { kind: 'session', id: 'other' })).toBe('none')
    expect(await shares.visibleIds(maya, 'session')).toEqual(new Set(['s1']))
    expect(await shares.visibleIds(maya, 'work')).toEqual(new Set())

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
    await shares.claimOwner(work, member('alice'))
    const link = (await shares.setLink({ resource: work, role: 'viewer' }, member('alice')))!
    expect((await shares.list(work, member('alice'))).link).toEqual({ role: 'viewer', secret: link.secret })
    expect((await shares.list(work, member('bob'))).link).toEqual({ role: 'viewer', secret: link.secret })
    const viewingGuest: Principal = {
      kind: 'guest', guestId: 'g2', displayName: 'Vee', deviceId: 'g2',
      share: { resource: work, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: hashLinkSecret(link.secret) },
      expiresAt: 0, deviceLabel: 'Guest link',
    }
    expect((await shares.list(work, viewingGuest)).link).toEqual({ role: 'viewer' })
    expect(await shares.setLink({ resource: work, role: 'editor' }, member('alice'))).toBeNull()
    expect((await shares.list(work, member('alice'))).link).toEqual({ role: 'editor', secret: link.secret })
    // A row made before the host kept the secret answers that a link exists, and no more.
    const { shareGrant } = await import('@solus/server/sharing/schema')
    await database.getDatabase().run(sql`
      UPDATE ${shareGrant} SET link_secret = NULL WHERE resource_kind = 'work' AND resource_id = 'w1' AND subject_kind = 'everyone'
    `)
    expect((await shares.list(work, member('alice'))).link).toEqual({ role: 'editor' })
  })

  test('ownership and the link on the stable session id also cover the provider thread id', async () => {
    // WHY: clients and the index name a session by whichever id they hold; access must not depend on which.
    const { shares } = manager((id) => (id === 'thread-1' ? 's1' : id))
    await shares.claimOwner({ kind: 'session', id: 'thread-1' }, member('alice'))
    expect(await shares.roleFor(member('alice'), { kind: 'session', id: 's1' })).toBe('owner')
    expect(await shares.roleFor(member('bob'), { kind: 'session', id: 'thread-1' })).toBe('editor')
    const link = (await shares.setLink({ resource: { kind: 'session', id: 's1' }, role: 'viewer' }, member('alice')))!
    const maya = guest(hashLinkSecret(link.secret))
    expect(await shares.roleFor(maya, { kind: 'session', id: 'thread-1' })).toBe('viewer')
    expect(await shares.filterVisible(maya, 'session', [{ sessionId: 'thread-1' }, { sessionId: 'other' }], (session) => session.sessionId)).toHaveLength(1)
  })
})
