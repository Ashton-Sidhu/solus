import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { ShareAccessError, ShareManager, hashLinkSecret, type ShareChange } from '@solus/server/sharing/share-manager'
import type { Principal } from '@solus/server/server/principal'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'

// docs/plans/multiplayer-sharing.md §3.4–§3.5: the creator owns a resource; the
// personal host's owner has every role; every member of the organization the host is
// shared with is an editor on everything (full visibility, decision 2026-09-15); the
// link is one `everyone` row whose secret the host keeps beside its hash and hands
// only to whoever may share; and a change is announced so guests can be dropped.

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const REMOTE_OWNER: Principal = { kind: 'remote-owner', userId: 'alice', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const member = (userId: string, teamIds: string[] = [], organizationRole: 'owner' | 'member' = 'member', hostKind: 'personal' | 'managed' = 'managed'): Principal => ({
  kind: 'org-member', userId, organizationId: 'org1', organizationRole, teamIds, hostKind, displayName: userId, deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})

function manager(canonical?: (id: string) => string) {
  // bun has no node:sqlite; its own Database speaks the same prepare/get/all/run/exec surface.
  const db = new Database(':memory:') as unknown as DatabaseSync
  const changes: ShareChange[] = []
  const shares = new ShareManager({ db, canonicalSessionId: canonical, now: () => 1_000 })
  shares.onChanged((change) => changes.push(change))
  return { shares, changes }
}

describe('ownership', () => {
  test('the first principal to claim a resource owns it; later claims change nothing', () => {
    const { shares } = manager()
    const work = { kind: 'work', id: 'w1' } as const
    expect(shares.claimOwner(work, member('bob'))).toBe('bob')
    expect(shares.claimOwner(work, member('cara'))).toBe('bob')
    expect(shares.roleFor(member('bob'), work)).toBe('owner')
    // Cara is in the organization: an editor, never the owner.
    expect(shares.roleFor(member('cara'), work)).toBe('editor')
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
    expect(shares.roleFor(member('bob'), work)).toBe('editor')
    expect(changes.at(-1)?.removedUserIds).toEqual(['bob'])
  })
})

describe('share rows', () => {
  test('every organization member is an editor on every resource, with or without a row', () => {
    // WHY: full visibility for teams (decision 2026-09-15). A team that shares a host
    // shares its work; a viewer row cannot demote a member below editor.
    const { shares } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    shares.claimOwner(doc, member('alice'))
    expect(shares.roleFor(member('bob'), doc)).toBe('editor')
    shares.setGrants({ resource: doc, grants: [
      { subject: { kind: 'organization', id: 'org1' }, role: 'viewer' },
      { subject: { kind: 'team', id: 'team-a' }, role: 'editor' },
    ] }, member('alice'))
    expect(shares.roleFor(member('bob'), doc)).toBe('editor')
    expect(shares.roleFor(member('cara', ['team-a']), doc)).toBe('editor')
    expect(shares.roleFor(member('dan', ['team-b']), doc)).toBe('editor')
  })

  test('any member may change the list, and removing a named row takes nothing from a member', () => {
    const { shares } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    shares.claimOwner(doc, member('alice'))
    shares.setGrants({ resource: doc, grants: [
      { subject: { kind: 'user', id: 'bob' }, role: 'editor' },
      { subject: { kind: 'user', id: 'cara' }, role: 'viewer' },
    ] }, member('alice'))
    const list = shares.setGrants({ resource: doc, grants: [{ subject: { kind: 'user', id: 'cara' }, role: 'editor' }] }, member('bob'))
    expect(list.grants.map((grant) => `${grant.subject.kind}:${'id' in grant.subject ? grant.subject.id : ''}=${grant.role}`)).toEqual(['user:cara=editor'])
    // bob removed his own row: membership still makes him an editor.
    expect(list.callerRole).toBe('editor')
    expect(shares.roleFor(member('bob'), doc)).toBe('editor')
  })

  test('removing a user row names them in the change so their client can show the notice', () => {
    const { shares, changes } = manager()
    const doc = { kind: 'work', id: 'w1' } as const
    shares.claimOwner(doc, member('alice'))
    shares.setGrants({ resource: doc, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, member('alice'))
    shares.setGrants({ resource: doc, grants: [] }, member('alice'))
    expect(changes.at(-1)).toMatchObject({ resource: doc, removedUserIds: ['bob'], guestsRevoked: false, changedBy: { userId: 'alice' } })
  })

  test('a listing shows a member everything on the host; a guest sees only its resource', () => {
    const { shares } = manager()
    shares.claimOwner({ kind: 'work', id: 'mine' }, member('bob'))
    shares.claimOwner({ kind: 'work', id: 'theirs' }, member('alice'))
    const works = [{ id: 'mine' }, { id: 'theirs' }]
    expect(shares.filterVisible(member('bob'), 'work', works, (work) => work.id)).toHaveLength(2)
    expect(shares.filterVisible(OWNER, 'work', works, (work) => work.id)).toHaveLength(2)
    expect(() => shares.list({ kind: 'work', id: 'theirs' }, member('bob'))).not.toThrow()
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
