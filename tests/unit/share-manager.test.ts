import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { ShareAccessError, ShareManager, hashLinkSecret, type ShareChange } from '@solus/server/sharing/share-manager'
import type { Principal } from '@solus/server/server/principal'
import { HOST_OWNER_USER_ID, type ShareResource } from '@solus/contracts/sharing'

// docs/plans/multiplayer-sharing.md §3.4–§3.5: the creator owns a resource; the
// personal host's owner has every role; a member holds what the rows give them —
// their team, the organization, or the link (scope, decision 2026-09-16), and a
// managed host's resources start shared with the organization; the link is one
// `everyone` row whose secret the host keeps beside its hash and hands only to
// whoever may share; and a change is announced so guests can be dropped.

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const REMOTE_OWNER: Principal = { kind: 'remote-owner', userId: 'alice', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const member = (userId: string, teamIds: string[] = [], organizationRole: 'owner' | 'member' = 'member', hostKind: 'personal' | 'managed' = 'managed', organizationId = 'org1'): Principal => ({
  kind: 'org-member', userId, organizationId, organizationRole, teamIds, hostKind, displayName: userId, deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})

/** A task tree in one line: task id → what is linked under it. */
type TaskTree = Record<string, ShareResource[]>

function manager(canonical?: (id: string) => string, tasks: TaskTree = {}) {
  // bun has no node:sqlite; its own Database speaks the same prepare/get/all/run/exec surface.
  const db = new Database(':memory:') as unknown as DatabaseSync
  const changes: ShareChange[] = []
  const shares = new ShareManager({
    db,
    canonicalSessionId: canonical,
    now: () => 1_000,
    taskContents: (taskId) => tasks[taskId] ?? [],
    containingTasks: (resource) => Object.entries(tasks)
      .filter(([, contents]) => contents.some((item) => item.kind === resource.kind && item.id === resource.id))
      .map(([taskId]) => ({ taskId, title: `Task ${taskId}` })),
  })
  shares.onChanged((change) => changes.push(change))
  return { shares, changes, db }
}

describe('ownership', () => {
  test('the first principal to claim a resource owns it; later claims change nothing', () => {
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    expect(shares.claimOwner(work, member('bob'))).toBe('bob')
    expect(shares.claimOwner(work, member('cara'))).toBe('bob')
    expect(shares.roleFor(member('bob'), work)).toBe('owner')
    // Cara is in the organization the managed host serves: an editor, never the owner.
    expect(shares.roleFor(member('cara'), work)).toBe('editor')
  })

  test('a managed host starts a resource shared with the organization; a personal host starts it private', () => {
    // WHY: the cloud machine is the team's, so its work is the team's to see until the
    // owner narrows it; a person's own machine shares nothing until they say so.
    const { shares } = manager()
    const cloud = { kind: 'work', id: 'cloud' } as const
    shares.claimOwner(cloud, member('bob'))
    expect(shares.list(cloud, member('bob')).grants).toEqual([
      { subject: { kind: 'organization', id: 'org1' }, role: 'editor', grantedByUserId: 'bob', createdAt: 1_000 },
    ])
    const personal = { kind: 'work', id: 'personal' } as const
    shares.claimOwner(personal, member('bob', [], 'member', 'personal'))
    expect(shares.list(personal, member('bob', [], 'member', 'personal')).grants).toEqual([])
    expect(shares.roleFor(member('cara', [], 'member', 'personal'), personal)).toBe('none')
    // The host owner's own work on their machine is theirs alone until shared.
    const mine = { kind: 'work', id: 'mine' } as const
    shares.claimOwner(mine, OWNER)
    expect(shares.roleFor(member('cara', [], 'member', 'personal'), mine)).toBe('none')
  })

  test('a resource made over a local connection is owned by the host owner, whom a remote owner also is', () => {
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    expect(shares.claimOwner(work, OWNER)).toBe(HOST_OWNER_USER_ID)
    expect(shares.roleFor(REMOTE_OWNER, work)).toBe('owner')
    expect(shares.roleFor(OWNER, work)).toBe('owner')
  })

  test('the personal host owner has every role on a member-owned resource; a managed-host organization owner is an editor like any member', () => {
    // WHY: the owner owns the disk; on a managed host nobody does (§3.4, §13).
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    shares.claimOwner(work, member('bob'))
    expect(shares.roleFor(OWNER, work)).toBe('owner')
    expect(shares.roleFor(member('admin', [], 'owner', 'managed'), work)).toBe('editor')
  })

  test('only the owner transfers; the previous owner is named as removed', () => {
    const { shares, changes } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    shares.claimOwner(work, member('bob'))
    expect(() => shares.transfer({ resource: work, toUserId: 'cara' }, member('cara'))).toThrow(ShareAccessError)
    const list = shares.transfer({ resource: work, toUserId: 'cara' }, member('bob'))
    expect(list.ownerUserId).toBe('cara')
    // The organization row from the claim still admits bob, as an editor now.
    expect(shares.roleFor(member('bob'), work)).toBe('editor')
    expect(changes.at(-1)?.removedUserIds).toEqual(['bob'])
  })
})

describe('share rows', () => {
  test('a member holds what the rows give: their team, the organization, or nothing', () => {
    // WHY: the dialog offers a scope (decision 2026-09-16). "Team A" must mean team A
    // and not the whole organization, or the choice would be a lie.
    const { shares } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    shares.claimOwner(doc, member('alice', [], 'member', 'personal'))
    expect(shares.roleFor(member('bob'), doc)).toBe('none')
    shares.setGrants({ resource: doc, grants: [{ subject: { kind: 'team', id: 'team-a' }, role: 'editor' }] }, member('alice'))
    expect(shares.roleFor(member('cara', ['team-a']), doc)).toBe('editor')
    expect(shares.roleFor(member('dan', ['team-b']), doc)).toBe('none')
    shares.setGrants({ resource: doc, grants: [
      { subject: { kind: 'organization', id: 'org1' }, role: 'viewer' },
      { subject: { kind: 'team', id: 'team-a' }, role: 'editor' },
    ] }, member('alice'))
    // The highest row wins; a member of another organization is admitted by none.
    expect(shares.roleFor(member('cara', ['team-a']), doc)).toBe('editor')
    expect(shares.roleFor(member('dan', ['team-b']), doc)).toBe('viewer')
    expect(shares.roleFor(member('eve', [], 'member', 'managed', 'org2'), doc)).toBe('none')
  })

  test('the host\'s own unowned work on a managed host is the team\'s to edit; on a personal host it is the owner\'s alone', () => {
    const { shares } = manager()
    const doc = { kind: 'work', id: 'automation' } as const
    expect(shares.roleFor(member('bob'), doc)).toBe('editor')
    expect(shares.roleFor(member('bob', [], 'member', 'personal'), doc)).toBe('none')
  })

  test('an editor through a row may change the list, and removing a named row takes their standing with it', () => {
    const { shares } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    shares.claimOwner(doc, member('alice'))
    shares.setGrants({ resource: doc, grants: [
      { subject: { kind: 'user', id: 'bob' }, role: 'editor' },
      { subject: { kind: 'user', id: 'cara' }, role: 'viewer' },
    ] }, member('alice'))
    const list = shares.setGrants({ resource: doc, grants: [{ subject: { kind: 'user', id: 'cara' }, role: 'editor' }] }, member('bob'))
    expect(list.grants.map((grant) => `${grant.subject.kind}:${'id' in grant.subject ? grant.subject.id : ''}=${grant.role}`)).toEqual(['user:cara=editor'])
    // bob removed his own row: the write still answers, with the list as it now stands.
    expect(list.callerRole).toBe('none')
    expect(shares.roleFor(member('bob'), doc)).toBe('none')
    expect(() => shares.setGrants({ resource: doc, grants: [] }, member('bob'))).toThrow(ShareAccessError)
  })

  test('removing a user row names them in the change so their client can show the notice', () => {
    const { shares, changes } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    shares.claimOwner(doc, member('alice'))
    shares.setGrants({ resource: doc, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, member('alice'))
    shares.setGrants({ resource: doc, grants: [] }, member('alice'))
    expect(changes.at(-1)).toMatchObject({ resource: doc, removedUserIds: ['bob'], guestsRevoked: false, changedBy: { userId: 'alice' } })
  })

  test('a listing shows a member what they own, what a row names them on, and the host\'s own work on a managed host', () => {
    // WHY: a sidebar row the member cannot open is a broken promise; a resource they
    // may open must never be missing from it either.
    const { shares } = manager()
    shares.claimOwner({ kind: 'work', id: 'mine' }, member('bob', [], 'member', 'personal'))
    shares.claimOwner({ kind: 'work', id: 'theirs' }, member('alice', [], 'member', 'personal'))
    shares.claimOwner({ kind: 'work', id: 'team' }, member('alice', [], 'member', 'personal'))
    shares.setGrants({ resource: { kind: 'work', id: 'team' }, grants: [{ subject: { kind: 'team', id: 'team-a' }, role: 'viewer' }] }, member('alice', [], 'member', 'personal'))
    const works = [{ id: 'mine' }, { id: 'theirs' }, { id: 'team' }, { id: 'unowned' }]
    const idOf = (work: { id: string }) => work.id
    expect(shares.filterVisible(member('bob', ['team-a'], 'member', 'personal'), 'work', works, idOf).map(idOf)).toEqual(['mine', 'team'])
    expect(shares.filterVisible(member('bob', [], 'member', 'personal'), 'work', works, idOf).map(idOf)).toEqual(['mine'])
    // On a managed host the unowned work is the host's own, and the team's to see.
    expect(shares.filterVisible(member('bob'), 'work', works, idOf).map(idOf)).toEqual(['mine', 'unowned'])
    expect(shares.filterVisible(OWNER, 'work', works, idOf)).toHaveLength(4)
    expect(() => shares.list({ kind: 'work', id: 'theirs' }, member('bob', [], 'member', 'personal'))).toThrow(ShareAccessError)
  })
})

describe('new sessions', () => {
  test('a session the host has never seen is the starter\'s; one it knows stays closed until shared', () => {
    // WHY: the access check runs before the first prompt claims ownership, so a
    // member could never start a session on a personal host otherwise.
    const db = new Database(':memory:') as unknown as DatabaseSync
    const known = new Set(['old'])
    const shares = new ShareManager({ db, now: () => 1_000, sessionExists: (id) => known.has(id) })
    const bob = member('bob', [], 'member', 'personal')
    expect(shares.roleFor(bob, { kind: 'session', id: 'fresh' })).toBe('owner')
    expect(shares.roleFor(bob, { kind: 'session', id: 'old' })).toBe('none')
    // Once someone has claimed it, a fresh id is theirs alone.
    shares.claimOwner({ kind: 'session', id: 'fresh' }, member('alice', [], 'member', 'personal'))
    expect(shares.roleFor(bob, { kind: 'session', id: 'fresh' })).toBe('none')
    // Works are never started this way: a work is created, and creation claims it.
    expect(shares.roleFor(bob, { kind: 'work', id: 'fresh' })).toBe('none')
  })
})

describe('tasks', () => {
  const personal = (userId: string, teamIds: string[] = []) => member(userId, teamIds, 'member', 'personal')
  const tree: TaskTree = { t1: [{ kind: 'session', id: 's1' }, { kind: 'work', id: 'w1' }], t2: [{ kind: 'session', id: 's9' }] }

  test('a task shared with someone shares its sessions and works at the task\'s role, short of ownership', () => {
    // WHY: "share everything in the task" is the promise; the task page alone
    // would be a list of doors that do not open.
    const { shares } = manager(undefined, tree)
    shares.claimOwner({ kind: 'task', id: 't1' }, personal('alice'))
    shares.claimOwner({ kind: 'session', id: 's1' }, personal('alice'))
    expect(shares.roleFor(personal('bob'), { kind: 'session', id: 's1' })).toBe('none')
    shares.setGrants({ resource: { kind: 'task', id: 't1' }, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, personal('alice'))
    expect(shares.roleFor(personal('bob'), { kind: 'task', id: 't1' })).toBe('viewer')
    expect(shares.roleFor(personal('bob'), { kind: 'session', id: 's1' })).toBe('viewer')
    expect(shares.roleFor(personal('bob'), { kind: 'work', id: 'w1' })).toBe('viewer')
    expect(shares.roleFor(personal('bob'), { kind: 'session', id: 's9' })).toBe('none')
    // The session's own row still wins when it is higher.
    shares.setGrants({ resource: { kind: 'session', id: 's1' }, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'editor' }] }, personal('alice'))
    expect(shares.roleFor(personal('bob'), { kind: 'session', id: 's1' })).toBe('editor')
    // The task's owner edits, but never owns, a session someone else started in it.
    shares.transfer({ resource: { kind: 'task', id: 't1' }, toUserId: 'cara' }, personal('alice'))
    expect(shares.roleFor(personal('cara'), { kind: 'session', id: 's1' })).toBe('editor')
    // The session's list names the task it is shared through.
    expect(shares.list({ kind: 'session', id: 's1' }, personal('alice')).inheritedFrom).toEqual([{ taskId: 't1', title: 'Task t1' }])
  })

  test('a listing shows what a shared task holds, and a guest on a task reaches exactly its contents', () => {
    const { shares } = manager(undefined, tree)
    shares.claimOwner({ kind: 'task', id: 't1' }, personal('alice'))
    shares.setGrants({ resource: { kind: 'task', id: 't1' }, grants: [{ subject: { kind: 'team', id: 'team-a' }, role: 'viewer' }] }, personal('alice'))
    const sessions = [{ id: 's1' }, { id: 's9' }]
    expect(shares.filterVisible(personal('bob', ['team-a']), 'session', sessions, (s) => s.id).map((s) => s.id)).toEqual(['s1'])
    expect(shares.filterVisible(personal('bob'), 'session', sessions, (s) => s.id)).toEqual([])
    expect(shares.filterVisible(personal('bob', ['team-a']), 'task', [{ id: 't1' }, { id: 't2' }], (t) => t.id).map((t) => t.id)).toEqual(['t1'])

    const link = shares.setLink({ resource: { kind: 'task', id: 't1' }, role: 'editor' }, personal('alice'))!
    const maya: Principal = {
      kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1',
      share: { resource: { kind: 'task', id: 't1' }, role: 'editor', sharedByUserId: 'alice', linkSecretHash: hashLinkSecret(link.secret) },
      expiresAt: 0, deviceLabel: 'Guest link',
    }
    expect(shares.roleFor(maya, { kind: 'task', id: 't1' })).toBe('editor')
    expect(shares.roleFor(maya, { kind: 'session', id: 's1' })).toBe('editor')
    expect(shares.roleFor(maya, { kind: 'work', id: 'w1' })).toBe('editor')
    expect(shares.roleFor(maya, { kind: 'session', id: 's9' })).toBe('none')
    expect(shares.visibleIds(maya, 'session')).toEqual(new Set(['s1']))
    expect(shares.visibleIds(maya, 'task')).toEqual(new Set(['t1']))
    shares.setLink({ resource: { kind: 'task', id: 't1' }, role: null }, personal('alice'))
    expect(shares.roleFor(maya, { kind: 'session', id: 's1' })).toBe('none')
  })

  test('a share table made before tasks could be shared is rebuilt with its rows and its indexes', () => {
    // WHY: SQLite cannot widen a CHECK; without the rebuild every task share would be refused on an older host.
    const db = new Database(':memory:') as unknown as DatabaseSync
    db.exec("CREATE TABLE resource_owner (resource_kind TEXT NOT NULL CHECK (resource_kind IN ('session', 'work')), resource_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (resource_kind, resource_id))")
    db.exec("CREATE TABLE share_grant (id TEXT PRIMARY KEY, resource_kind TEXT NOT NULL CHECK (resource_kind IN ('session', 'work')), resource_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, link_secret_hash TEXT, link_secret TEXT, granted_by_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (resource_kind, resource_id, subject_kind, subject_id))")
    db.exec('CREATE INDEX IF NOT EXISTS share_grant_resource_idx ON share_grant(resource_kind, resource_id)')
    db.prepare("INSERT INTO resource_owner VALUES ('work', 'w1', 'alice', 1)").run()
    db.prepare("INSERT INTO share_grant VALUES ('g1', 'work', 'w1', 'user', 'bob', 'viewer', NULL, NULL, 'alice', 1)").run()
    const shares = new ShareManager({ db, now: () => 1_000 })
    expect(shares.roleFor(member('bob', [], 'member', 'personal'), { kind: 'work', id: 'w1' })).toBe('viewer')
    expect(shares.claimOwner({ kind: 'task', id: 't1' }, member('alice', [], 'member', 'personal'))).toBe('alice')
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'share_grant'").all() as { name: string }[]).map((row) => row.name)
    expect(indexes).toContain('share_grant_resource_idx')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_before_tasks'").all()).toEqual([])
  })
})

describe('the link and guests', () => {
  const guest = (secretHash: string, role: 'viewer' | 'editor' = 'viewer'): Principal => ({
    kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1',
    share: { resource: { kind: 'session', id: 's1' }, role, sharedByUserId: 'alice', linkSecretHash: secretHash },
    expiresAt: 0, deviceLabel: 'Guest link',
  })

  test('the secret admits by its hash and resolves to one resource and role', () => {
    const { shares } = manager()
    const session = { kind: 'session', id: 's1' } as const
    shares.claimOwner(session, member('alice'))
    const link = shares.setLink({ resource: session, role: 'viewer' }, member('alice'))!
    expect(link.secret.length).toBeGreaterThan(30)
    expect(shares.resolveLinkSecret(link.secret)).toEqual({ resource: session, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: hashLinkSecret(link.secret) })
    expect(shares.resolveLinkSecret('nope')).toBeNull()
    expect(shares.list(session, member('alice')).link).toEqual({ role: 'viewer', secret: link.secret })
    // Changing the role keeps the secret: no new secret comes back.
    expect(shares.setLink({ resource: session, role: 'editor' }, member('alice'))).toBeNull()
    expect(shares.resolveLinkSecret(link.secret)?.role).toBe('editor')
  })

  test('a guest is bound to its resource and loses access the moment the link is regenerated or removed', () => {
    const { shares, changes } = manager()
    const session = { kind: 'session', id: 's1' } as const
    shares.claimOwner(session, member('alice'))
    const link = shares.setLink({ resource: session, role: 'viewer' }, member('alice'))!
    const maya = guest(hashLinkSecret(link.secret))
    expect(shares.roleFor(maya, session)).toBe('viewer')
    expect(shares.roleFor(maya, { kind: 'session', id: 'other' })).toBe('none')
    expect(shares.visibleIds(maya, 'session')).toEqual(new Set(['s1']))
    expect(shares.visibleIds(maya, 'work')).toEqual(new Set())

    const rotated = shares.setLink({ resource: session, role: 'viewer', regenerate: true }, member('alice'))!
    expect(rotated.secret).not.toBe(link.secret)
    expect(shares.roleFor(maya, session)).toBe('none')
    expect(changes.at(-1)?.guestsRevoked).toBe(true)

    shares.setLink({ resource: session, role: null }, member('alice'))
    expect(shares.resolveLinkSecret(rotated.secret)).toBeNull()
    expect(changes.at(-1)?.guestsRevoked).toBe(true)
  })

  test('the link is always at hand for the owner and members, never for a viewing guest, and survives a role change', () => {
    // WHY: a share control is only useful when the link can be copied any time; a
    // viewer must never be handed the secret through the list.
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    shares.claimOwner(work, member('alice'))
    const link = shares.setLink({ resource: work, role: 'viewer' }, member('alice'))!
    expect(shares.list(work, member('alice')).link).toEqual({ role: 'viewer', secret: link.secret })
    expect(shares.list(work, member('bob')).link).toEqual({ role: 'viewer', secret: link.secret })
    const viewingGuest: Principal = {
      kind: 'guest', guestId: 'g2', displayName: 'Vee', deviceId: 'g2',
      share: { resource: work, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: hashLinkSecret(link.secret) },
      expiresAt: 0, deviceLabel: 'Guest link',
    }
    expect(shares.list(work, viewingGuest).link).toEqual({ role: 'viewer' })
    expect(shares.setLink({ resource: work, role: 'editor' }, member('alice'))).toBeNull()
    expect(shares.list(work, member('alice')).link).toEqual({ role: 'editor', secret: link.secret })
    // A table made before the column existed gains it without losing its rows.
    const db = new Database(':memory:') as unknown as DatabaseSync
    db.exec("CREATE TABLE share_grant (id TEXT PRIMARY KEY, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, link_secret_hash TEXT, granted_by_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (resource_kind, resource_id, subject_kind, subject_id))")
    db.prepare("INSERT INTO share_grant VALUES ('g1', 'work', 'w1', 'everyone', '', 'viewer', 'hash', 'alice', 1)").run()
    const upgraded = new ShareManager({ db, now: () => 1_000 })
    upgraded.claimOwner(work, member('alice'))
    expect(upgraded.list(work, member('alice')).link).toEqual({ role: 'viewer' })
  })

  test('ownership and the link on the stable session id also cover the provider thread id', () => {
    // WHY: clients and the index name a session by whichever id they hold; access must not depend on which.
    const { shares } = manager((id) => (id === 'thread-1' ? 's1' : id))
    shares.claimOwner({ kind: 'session', id: 'thread-1' }, member('alice'))
    expect(shares.roleFor(member('alice'), { kind: 'session', id: 's1' })).toBe('owner')
    expect(shares.roleFor(member('bob'), { kind: 'session', id: 'thread-1' })).toBe('editor')
    const link = shares.setLink({ resource: { kind: 'session', id: 's1' }, role: 'viewer' }, member('alice'))!
    const maya = guest(hashLinkSecret(link.secret))
    expect(shares.roleFor(maya, { kind: 'session', id: 'thread-1' })).toBe('viewer')
    expect(shares.filterVisible(maya, 'session', [{ sessionId: 'thread-1' }, { sessionId: 'other' }], (session) => session.sessionId)).toHaveLength(1)
  })
})
