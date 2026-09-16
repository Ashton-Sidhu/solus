import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  HOST_OWNER_USER_ID,
  resourceRoleAtLeast,
  shareNamedSubjectSchema,
  type ResourceRole,
  type ShareChangedEvent,
  type ShareGrant,
  type ShareLink,
  type ShareList,
  type ShareNamedSubject,
  type ShareResource,
  type ShareResourceKind,
  type ShareRole,
  type ShareSetLinkRequest,
  type ShareSetRequest,
  type ShareTransferRequest,
} from '@solus/contracts/sharing'
import { createLogger } from '../logger'
import { isHostOwner, principalDisplayName, principalOwnerId, type Principal } from '../server/principal'

const log = createLogger('main', 'share-manager')

/** What membership in the host's organization is worth on every resource (full visibility, decision 2026-09-15). */
const TEAM_MEMBER_ROLE: ResourceRole = 'editor'

/**
 * Who may open which session or work on this host
 * (docs/plans/multiplayer-sharing.md §3.4). This file owns every row it reads: the
 * owner of each resource and the share list. Nothing else joins these tables, and the
 * database handle is injected, so a managed host that moves to Postgres ports this
 * one file (§13).
 *
 * Ownership is recorded here rather than on the `sessions` and `works` rows because a
 * session's index row is rewritten by the transcript indexer and a project work has no
 * row at all. One table, one key `(kind, id)`, covers both.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resource_owner (
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('session', 'work')),
  resource_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_kind, resource_id)
);

CREATE TABLE IF NOT EXISTS share_grant (
  id TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('session', 'work')),
  resource_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'team', 'organization', 'everyone')),
  subject_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  link_secret_hash TEXT,
  link_secret TEXT,
  granted_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (resource_kind, resource_id, subject_kind, subject_id)
);
CREATE INDEX IF NOT EXISTS share_grant_resource_idx ON share_grant(resource_kind, resource_id);
CREATE INDEX IF NOT EXISTS share_grant_secret_idx ON share_grant(link_secret_hash) WHERE link_secret_hash IS NOT NULL;
`

const grantRowSchema = z.object({
  resource_kind: z.enum(['session', 'work']),
  resource_id: z.string(),
  subject_kind: z.enum(['user', 'team', 'organization', 'everyone']),
  subject_id: z.string(),
  role: z.enum(['viewer', 'editor']),
  link_secret_hash: z.string().nullable(),
  /** The secret itself, kept so the link is always at hand; null on a row made before the column existed. */
  link_secret: z.string().nullable(),
  granted_by_user_id: z.string(),
  created_at: z.number(),
})
type GrantRow = z.infer<typeof grantRowSchema>

const columnRowSchema = z.object({ name: z.string() })

const ownerRowSchema = z.object({ owner_user_id: z.string() })

export class ShareAccessError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_SHARED', message: string) {
    super(message)
    this.name = 'ShareAccessError'
  }
}

export interface ResolvedLinkShare {
  resource: ShareResource
  role: ShareRole
  sharedByUserId: string
  linkSecretHash: string
}

/** What a share change means to connected clients; the transport and the publisher act on it. */
export interface ShareChange extends ShareChangedEvent {
  /** The guest link was removed or regenerated: every guest socket on this resource ends now. */
  guestsRevoked: boolean
}

export interface ShareManagerDeps {
  db: DatabaseSync
  /**
   * A session is addressed by its stable Solus id, but some calls carry a provider
   * thread id. The lineage table maps one to the other; identity when it has no row.
   */
  canonicalSessionId?: (sessionId: string) => string
  now?: () => number
}

export function hashLinkSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export class ShareManager {
  private readonly listeners = new Set<(change: ShareChange) => void>()

  constructor(private readonly deps: ShareManagerDeps) {
    deps.db.exec(SCHEMA)
    // A table made before the host kept link secrets: add the column, leave the rows.
    const columns = columnRowSchema.array().parse(deps.db.prepare('PRAGMA table_info(share_grant)').all())
    if (!columns.some((column) => column.name === 'link_secret')) {
      deps.db.exec('ALTER TABLE share_grant ADD COLUMN link_secret TEXT')
    }
  }

  onChanged(listener: (change: ShareChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Session ids are normalized so a share made on the stable id also covers the provider id. */
  canonical(resource: ShareResource): ShareResource {
    if (resource.kind !== 'session' || !this.deps.canonicalSessionId) return resource
    const id = this.deps.canonicalSessionId(resource.id)
    return id === resource.id ? resource : { kind: 'session', id }
  }

  // ── Ownership ───────────────────────────────────────────────────────────

  ownerOf(resource: ShareResource): string | null {
    const canonical = this.canonical(resource)
    const row = ownerRowSchema.nullish().parse(
      this.deps.db.prepare('SELECT owner_user_id FROM resource_owner WHERE resource_kind = ? AND resource_id = ?')
        .get(canonical.kind, canonical.id),
    )
    return row?.owner_user_id ?? null
  }

  /**
   * The first principal to start a session or create a work owns it. A later call
   * for the same resource changes nothing, so every entry point may claim freely.
   */
  claimOwner(resource: ShareResource, principal: Principal): string | null {
    const ownerUserId = principalOwnerId(principal)
    if (!ownerUserId) return this.ownerOf(resource)
    const canonical = this.canonical(resource)
    this.deps.db.prepare(`
      INSERT INTO resource_owner (resource_kind, resource_id, owner_user_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(resource_kind, resource_id) DO NOTHING
    `).run(canonical.kind, canonical.id, ownerUserId, this.now())
    return this.ownerOf(canonical)
  }

  /** Only the owner may hand a resource to another member; the change is announced to everyone with access. */
  transfer(request: ShareTransferRequest, principal: Principal): ShareList {
    const resource = this.canonical(request.resource)
    if (this.roleFor(principal, resource) !== 'owner') {
      throw new ShareAccessError('FORBIDDEN', 'Only the owner can transfer ownership')
    }
    const previousOwner = this.ownerOf(resource)
    this.deps.db.prepare(`
      INSERT INTO resource_owner (resource_kind, resource_id, owner_user_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(resource_kind, resource_id) DO UPDATE SET owner_user_id = excluded.owner_user_id
    `).run(resource.kind, resource.id, request.toUserId, this.now())
    log.info('share_ownership_transferred', { kind: resource.kind, resourceId: resource.id, toUserId: request.toUserId })
    this.announce(resource, principal, previousOwner && previousOwner !== request.toUserId ? [previousOwner] : [], false)
    return this.buildList(resource, this.roleFor(principal, resource))
  }

  // ── Roles ───────────────────────────────────────────────────────────────

  /** The highest role this principal holds on the resource (§3.4, §3.5). */
  roleFor(principal: Principal, resource: ShareResource): ResourceRole {
    const canonical = this.canonical(resource)
    if (principal.kind === 'system') return 'owner'
    if (isHostOwner(principal)) return 'owner'
    if (principal.kind === 'guest') {
      const bound = this.canonical(principal.share.resource)
      if (bound.kind !== canonical.kind || bound.id !== canonical.id) return 'none'
      // The link the guest arrived with must still exist unchanged.
      const row = this.grantRows(canonical).find((grant) => grant.subject_kind === 'everyone')
      if (!row || row.link_secret_hash !== principal.share.linkSecretHash) return 'none'
      return row.role
    }
    const owner = this.ownerOf(canonical)
    if (owner === principal.userId) return 'owner'
    // Team hosts have full visibility (decision 2026-09-15): a member of the
    // organization the host is shared with is an editor on every session and work
    // here. Named rows can raise nobody above that, so they are not consulted; the
    // owner alone deletes and transfers.
    return TEAM_MEMBER_ROLE
  }

  assertRole(principal: Principal, resource: ShareResource, required: ResourceRole): void {
    if (!resourceRoleAtLeast(this.roleFor(principal, resource), required)) {
      throw new ShareAccessError('FORBIDDEN', `This ${resource.kind} is not shared with you`)
    }
  }

  /**
   * The resource ids of one kind this principal may open, or `all` for a principal
   * that is not filtered. List RPCs never return an id the caller cannot open.
   */
  visibleIds(principal: Principal, kind: ShareResourceKind): 'all' | Set<string> {
    if (principal.kind === 'guest') {
      const bound = this.canonical(principal.share.resource)
      return bound.kind === kind && this.roleFor(principal, bound) !== 'none' ? new Set([bound.id]) : new Set()
    }
    // The owner, the host itself, and every organization member see the whole host.
    return 'all'
  }

  /** Filters a listing to what the caller may open, matching either the stable or the provider session id. */
  filterVisible<T>(principal: Principal, kind: ShareResourceKind, items: T[], idOf: (item: T) => string): T[] {
    const visible = this.visibleIds(principal, kind)
    if (visible === 'all') return items
    return items.filter((item) => {
      const id = idOf(item)
      return visible.has(id) || visible.has(this.canonical({ kind, id }).id)
    })
  }

  // ── The share list ──────────────────────────────────────────────────────

  list(resourceInput: ShareResource, principal: Principal): ShareList {
    const resource = this.canonical(resourceInput)
    const callerRole = this.roleFor(principal, resource)
    if (callerRole === 'none') throw new ShareAccessError('FORBIDDEN', `This ${resource.kind} is not shared with you`)
    return this.buildList(resource, callerRole)
  }

  /** A write answers with the list as it now stands, even when the writer just removed their own access. */
  private buildList(resource: ShareResource, callerRole: ResourceRole): ShareList {
    const rows = this.grantRows(resource)
    const link = rows.find((row) => row.subject_kind === 'everyone')
    const grants: ShareGrant[] = rows
      .filter((row) => row.subject_kind !== 'everyone')
      .map((row) => ({
        subject: row.subject_kind === 'user'
          ? { kind: 'user', id: row.subject_id }
          : row.subject_kind === 'team'
            ? { kind: 'team', id: row.subject_id }
            : { kind: 'organization', id: row.subject_id },
        role: row.role,
        grantedByUserId: row.granted_by_user_id,
        createdAt: row.created_at,
      }))
    // The secret goes to whoever may change the link; a viewer learns only that one exists.
    const shareLink: ShareList['link'] = link ? { role: link.role } : null
    if (shareLink && link?.link_secret && resourceRoleAtLeast(callerRole, 'editor')) shareLink.secret = link.link_secret
    return {
      resource,
      ownerUserId: this.ownerOf(resource) ?? HOST_OWNER_USER_ID,
      grants,
      callerRole,
      link: shareLink,
    }
  }

  /** Replaces every named row. The owner and editors may share; a viewer may not (§3.4). */
  setGrants(request: ShareSetRequest, principal: Principal): ShareList {
    const resource = this.canonical(request.resource)
    this.assertRole(principal, resource, 'editor')
    const grantedBy = principalOwnerId(principal) ?? HOST_OWNER_USER_ID
    const before = this.grantRows(resource).filter((row) => row.subject_kind !== 'everyone')
    const next = new Map<string, { subject: ShareNamedSubject; role: ShareRole }>()
    for (const grant of request.grants) {
      const subject = shareNamedSubjectSchema.parse(grant.subject)
      next.set(`${subject.kind}:${subject.id}`, { subject, role: grant.role })
    }
    const removedUserIds: string[] = []
    const db = this.deps.db
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of before) {
        const key = `${row.subject_kind}:${row.subject_id}`
        if (next.has(key)) continue
        db.prepare('DELETE FROM share_grant WHERE resource_kind = ? AND resource_id = ? AND subject_kind = ? AND subject_id = ?')
          .run(resource.kind, resource.id, row.subject_kind, row.subject_id)
        if (row.subject_kind === 'user') removedUserIds.push(row.subject_id)
      }
      for (const { subject, role } of next.values()) {
        db.prepare(`
          INSERT INTO share_grant (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(resource_kind, resource_id, subject_kind, subject_id) DO UPDATE SET role = excluded.role
        `).run(randomUUID(), resource.kind, resource.id, subject.kind, subject.id, role, grantedBy, this.now())
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    log.info('share_grants_set', { kind: resource.kind, resourceId: resource.id, grants: next.size, removed: removedUserIds.length })
    this.announce(resource, principal, removedUserIds, false)
    return this.buildList(resource, this.roleFor(principal, resource))
  }

  /**
   * The link: one `everyone` row. A new secret is returned here and thereafter in the
   * share list to the owner and editors. Turning the link off or regenerating it
   * disconnects every guest at once (§3.4).
   */
  setLink(request: ShareSetLinkRequest, principal: Principal): ShareLink | null {
    const resource = this.canonical(request.resource)
    this.assertRole(principal, resource, 'editor')
    const existing = this.grantRows(resource).find((row) => row.subject_kind === 'everyone')
    const db = this.deps.db
    if (request.role === null) {
      if (!existing) return null
      db.prepare("DELETE FROM share_grant WHERE resource_kind = ? AND resource_id = ? AND subject_kind = 'everyone'")
        .run(resource.kind, resource.id)
      log.info('share_link_removed', { kind: resource.kind, resourceId: resource.id })
      this.announce(resource, principal, [], true)
      return null
    }
    const rotate = !existing || request.regenerate === true
    const secret = rotate ? randomBytes(32).toString('base64url') : null
    const grantedBy = principalOwnerId(principal) ?? HOST_OWNER_USER_ID
    if (rotate) {
      db.prepare(`
        INSERT INTO share_grant (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, link_secret, granted_by_user_id, created_at)
        VALUES (?, ?, ?, 'everyone', '', ?, ?, ?, ?, ?)
        ON CONFLICT(resource_kind, resource_id, subject_kind, subject_id) DO UPDATE SET
          role = excluded.role, link_secret_hash = excluded.link_secret_hash, link_secret = excluded.link_secret, granted_by_user_id = excluded.granted_by_user_id
      `).run(randomUUID(), resource.kind, resource.id, request.role, hashLinkSecret(secret!), secret, grantedBy, this.now())
    } else {
      db.prepare("UPDATE share_grant SET role = ? WHERE resource_kind = ? AND resource_id = ? AND subject_kind = 'everyone'")
        .run(request.role, resource.kind, resource.id)
    }
    log.info('share_link_set', { kind: resource.kind, resourceId: resource.id, role: request.role, rotated: rotate })
    // A regenerated secret ends the old guests; a role change alone lets them stay with the new role.
    this.announce(resource, principal, [], rotate && !!existing)
    if (!secret) return null
    return { role: request.role, secret }
  }

  /** Admission: the secret names one resource and one role, or nothing. */
  resolveLinkSecret(secret: string): ResolvedLinkShare | null {
    const hash = hashLinkSecret(secret)
    const row = grantRowSchema.nullish().parse(
      this.deps.db.prepare("SELECT * FROM share_grant WHERE subject_kind = 'everyone' AND link_secret_hash = ?").get(hash),
    )
    if (!row) return null
    return {
      resource: { kind: row.resource_kind, id: row.resource_id },
      role: row.role,
      sharedByUserId: row.granted_by_user_id,
      linkSecretHash: hash,
    }
  }

  /** Removes every row and the owner record when a resource is deleted. */
  forget(resource: ShareResource): void {
    const canonical = this.canonical(resource)
    this.deps.db.prepare('DELETE FROM share_grant WHERE resource_kind = ? AND resource_id = ?').run(canonical.kind, canonical.id)
    this.deps.db.prepare('DELETE FROM resource_owner WHERE resource_kind = ? AND resource_id = ?').run(canonical.kind, canonical.id)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private grantRows(resource: ShareResource): GrantRow[] {
    return grantRowSchema.array().parse(
      this.deps.db.prepare('SELECT * FROM share_grant WHERE resource_kind = ? AND resource_id = ? ORDER BY created_at, id')
        .all(resource.kind, resource.id),
    )
  }

  private announce(resource: ShareResource, principal: Principal, removedUserIds: string[], guestsRevoked: boolean): void {
    const change: ShareChange = {
      resource,
      ownerUserId: this.ownerOf(resource) ?? HOST_OWNER_USER_ID,
      changedBy: { userId: principalOwnerId(principal) ?? HOST_OWNER_USER_ID, displayName: principalDisplayName(principal) },
      removedUserIds,
      guestsRevoked,
    }
    for (const listener of this.listeners) {
      try { listener(change) } catch (error) {
        log.warn('share_change_listener_failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
