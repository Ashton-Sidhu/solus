import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  HOST_OWNER_USER_ID,
  higherResourceRole,
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

/**
 * What a resource starts with on a managed host (decision 2026-09-16): the
 * organization, as editors. The dialog offers one choice — who can open it — with
 * a viewer-or-editor role on each level; this is the role the first level gets.
 */
const SCOPE_ROLE: ShareRole = 'editor'

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

const RESOURCE_KINDS_SQL = "('session', 'work', 'task')"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resource_owner (
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ${RESOURCE_KINDS_SQL}),
  resource_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_kind, resource_id)
);

CREATE TABLE IF NOT EXISTS share_grant (
  id TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ${RESOURCE_KINDS_SQL}),
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
  resource_kind: z.enum(['session', 'work', 'task']),
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
const tableSqlRowSchema = z.object({ name: z.string(), sql: z.string() })

const ownerRowSchema = z.object({ owner_user_id: z.string() })
const ownerRowsSchema = z.array(z.object({ resource_id: z.string() }))

/** A task this resource is linked to, as the share list names it. */
export interface ContainingTask {
  taskId: string
  title: string
}

/** The role a resource inherits from a shared task it sits in: never ownership (§3.4). */
function inheritedRole(role: ResourceRole): ResourceRole {
  return role === 'owner' ? 'editor' : role
}

function sameResource(a: ShareResource, b: ShareResource): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** Whether a named row is about this member: them, a team they are in, or their organization. */
function rowAdmits(row: GrantRow, principal: Extract<Principal, { kind: 'org-member' }>): boolean {
  switch (row.subject_kind) {
    case 'user': return row.subject_id === principal.userId
    case 'team': return principal.teamIds.includes(row.subject_id)
    case 'organization': return row.subject_id === principal.organizationId
    case 'everyone': return false
  }
}

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
  /**
   * A task's share reaches what is linked to it (§3.4): the sessions and works of
   * one task, and the tasks a session or work is linked to. The tasks domain
   * answers both; without it a task shares only its own page.
   */
  taskContents?: (taskId: string) => ShareResource[]
  containingTasks?: (resource: ShareResource) => ContainingTask[]
  /**
   * Whether the host has any record of a session. A session nobody has recorded
   * yet is new, and the member starting it may: the access check runs before the
   * first prompt claims ownership. Without it every unowned session is closed.
   */
  sessionExists?: (sessionId: string) => boolean
  now?: () => number
}

export function hashLinkSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export class ShareManager {
  private readonly listeners = new Set<(change: ShareChange) => void>()

  constructor(private readonly deps: ShareManagerDeps) {
    // A table made before tasks could be shared carries a CHECK that refuses the
    // kind; SQLite cannot alter a constraint, so the table is rebuilt with its rows.
    for (const table of ['resource_owner', 'share_grant']) {
      const existing = tableSqlRowSchema.nullish().parse(
        deps.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      )
      if (existing && !existing.sql.includes("'task'")) {
        deps.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_before_tasks`)
      }
    }
    deps.db.exec(SCHEMA)
    for (const table of ['resource_owner', 'share_grant']) {
      const renamed = tableSqlRowSchema.nullish().parse(
        deps.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(`${table}_before_tasks`),
      )
      if (!renamed) continue
      const columns = columnRowSchema.array().parse(deps.db.prepare(`PRAGMA table_info(${table}_before_tasks)`).all()).map((column) => column.name).join(', ')
      deps.db.exec(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_before_tasks`)
      deps.db.exec(`DROP TABLE ${table}_before_tasks`)
      // The old table took its indexes with it under their names; make them again.
      deps.db.exec(SCHEMA)
      log.info('share_table_rebuilt_for_tasks', { table })
    }
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
   *
   * A resource made on a managed host starts shared with the organization the
   * host serves: the machine is the team's, so its work is visible to the team
   * until the owner narrows it. A personal host's resources start private.
   */
  claimOwner(resource: ShareResource, principal: Principal): string | null {
    const ownerUserId = principalOwnerId(principal)
    if (!ownerUserId) return this.ownerOf(resource)
    const canonical = this.canonical(resource)
    const inserted = this.deps.db.prepare(`
      INSERT INTO resource_owner (resource_kind, resource_id, owner_user_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(resource_kind, resource_id) DO NOTHING
    `).run(canonical.kind, canonical.id, ownerUserId, this.now())
    if (Number(inserted.changes) > 0 && principal.kind === 'org-member' && principal.hostKind === 'managed') {
      this.deps.db.prepare(`
        INSERT INTO share_grant (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at)
        VALUES (?, ?, ?, 'organization', ?, ?, NULL, ?, ?)
        ON CONFLICT(resource_kind, resource_id, subject_kind, subject_id) DO NOTHING
      `).run(randomUUID(), canonical.kind, canonical.id, principal.organizationId, SCOPE_ROLE, ownerUserId, this.now())
    }
    return this.ownerOf(canonical)
  }

  /** Only the owner may hand a resource to another member; the change is announced to everyone with access. */
  transfer(request: ShareTransferRequest, principal: Principal): ShareList {
    const resource = this.canonical(request.resource)
    if (this.roleFor(principal, request.resource) !== 'owner') {
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
    return this.buildList(resource, this.roleFor(principal, request.resource), request.resource)
  }

  // ── Roles ───────────────────────────────────────────────────────────────

  /**
   * The highest role this principal holds on the resource (§3.4, §3.5). A session
   * or work also holds what the tasks it is linked to give, short of ownership: a
   * task shared with someone shares everything in it.
   */
  roleFor(principal: Principal, resource: ShareResource): ResourceRole {
    const canonical = this.canonical(resource)
    if (principal.kind === 'system') return 'owner'
    if (isHostOwner(principal)) return 'owner'
    if (principal.kind === 'guest') {
      const bound = this.canonical(principal.share.resource)
      const reaches = sameResource(bound, canonical)
        || (bound.kind === 'task' && this.taskContents(bound.id).some((item) => sameResource(item, canonical)))
      if (!reaches) return 'none'
      // The link the guest arrived with must still exist unchanged.
      const row = this.grantRows(bound).find((grant) => grant.subject_kind === 'everyone')
      if (!row || row.link_secret_hash !== principal.share.linkSecretHash) return 'none'
      return row.role
    }
    let role = this.ownRoleFor(principal, canonical)
    for (const task of this.containingTasks(resource, canonical)) {
      if (role === 'owner') break
      role = higherResourceRole(role, inheritedRole(this.ownRoleFor(principal, { kind: 'task', id: task.taskId })))
    }
    return role
  }

  /** A member's standing on one resource from its owner record and its own rows alone. */
  private ownRoleFor(principal: Extract<Principal, { kind: 'org-member' }>, canonical: ShareResource): ResourceRole {
    const owner = this.ownerOf(canonical)
    if (owner === principal.userId) return 'owner'
    // A session the host has never seen is being started right now: it is the
    // starter's, and the prompt that follows records that.
    if (owner === null && canonical.kind === 'session' && this.deps.sessionExists && !this.deps.sessionExists(canonical.id)) return 'owner'
    // A member holds what the rows give them: their own row, a team they are in,
    // or the organization. The host's own work on a managed host — automations,
    // which no person owns — is the team's to edit.
    let role: ResourceRole = 'none'
    for (const row of this.grantRows(canonical)) {
      if (rowAdmits(row, principal)) role = higherResourceRole(role, row.role)
    }
    if (role === 'none' && owner === null && principal.hostKind === 'managed') return SCOPE_ROLE
    return role
  }

  private taskContents(taskId: string): ShareResource[] {
    return (this.deps.taskContents?.(taskId) ?? []).map((item) => this.canonical(item))
  }

  /**
   * The tasks a session or work sits in. A task link may hold either the stable
   * session id or the provider thread id, so both spellings are asked for.
   */
  private containingTasks(resource: ShareResource, canonical: ShareResource): ContainingTask[] {
    if (!this.deps.containingTasks || canonical.kind === 'task') return []
    const tasks = new Map<string, ContainingTask>()
    for (const spelling of sameResource(resource, canonical) ? [canonical] : [canonical, resource]) {
      for (const task of this.deps.containingTasks(spelling)) tasks.set(task.taskId, task)
    }
    return [...tasks.values()]
  }

  assertRole(principal: Principal, resource: ShareResource, required: ResourceRole): void {
    if (!resourceRoleAtLeast(this.roleFor(principal, resource), required)) {
      throw new ShareAccessError('FORBIDDEN', `This ${resource.kind} is not shared with you`)
    }
  }

  /**
   * The resource ids of one kind this principal may open, or `all` for a principal
   * that is not filtered. List RPCs never return an id the caller cannot open. A
   * member's set is what they own and what a row names them on; the host's own
   * unowned work on a managed host is added by `filterVisible`, which sees the items.
   */
  visibleIds(principal: Principal, kind: ShareResourceKind): 'all' | Set<string> {
    if (principal.kind === 'guest') {
      const bound = this.canonical(principal.share.resource)
      if (this.roleFor(principal, bound) === 'none') return new Set()
      const ids = new Set<string>()
      if (bound.kind === kind) ids.add(bound.id)
      if (bound.kind === 'task') for (const item of this.taskContents(bound.id)) if (item.kind === kind) ids.add(item.id)
      return ids
    }
    if (principal.kind !== 'org-member') return 'all'
    const ids = this.ownVisibleIds(principal, kind)
    // What a shared task holds is visible with it.
    if (kind !== 'task') {
      for (const taskId of this.ownVisibleIds(principal, 'task')) {
        for (const item of this.taskContents(taskId)) if (item.kind === kind) ids.add(item.id)
      }
    }
    return ids
  }

  /** The ids of one kind a member owns or is named on, before any task inheritance. */
  private ownVisibleIds(principal: Extract<Principal, { kind: 'org-member' }>, kind: ShareResourceKind): Set<string> {
    const ids = new Set<string>()
    const owned = ownerRowsSchema.parse(
      this.deps.db.prepare('SELECT resource_id FROM resource_owner WHERE resource_kind = ? AND owner_user_id = ?').all(kind, principal.userId),
    )
    for (const row of owned) ids.add(row.resource_id)
    const granted = grantRowSchema.array().parse(
      this.deps.db.prepare("SELECT * FROM share_grant WHERE resource_kind = ? AND subject_kind != 'everyone'").all(kind),
    )
    for (const row of granted) if (rowAdmits(row, principal)) ids.add(row.resource_id)
    return ids
  }

  /** Filters a listing to what the caller may open, matching either the stable or the provider session id. */
  filterVisible<T>(principal: Principal, kind: ShareResourceKind, items: T[], idOf: (item: T) => string): T[] {
    const visible = this.visibleIds(principal, kind)
    if (visible === 'all') return items
    // On a managed host, a resource nobody owns is the host's own work and the team's to see.
    const owned = principal.kind === 'org-member' && principal.hostKind === 'managed'
      ? new Set(ownerRowsSchema.parse(this.deps.db.prepare('SELECT resource_id FROM resource_owner WHERE resource_kind = ?').all(kind)).map((row) => row.resource_id))
      : null
    return items.filter((item) => {
      const id = idOf(item)
      const canonicalId = this.canonical({ kind, id }).id
      if (visible.has(id) || visible.has(canonicalId)) return true
      return owned !== null && !owned.has(canonicalId)
    })
  }

  // ── The share list ──────────────────────────────────────────────────────

  list(resourceInput: ShareResource, principal: Principal): ShareList {
    const resource = this.canonical(resourceInput)
    const callerRole = this.roleFor(principal, resourceInput)
    if (callerRole === 'none') throw new ShareAccessError('FORBIDDEN', `This ${resource.kind} is not shared with you`)
    return this.buildList(resource, callerRole, resourceInput)
  }

  /** A write answers with the list as it now stands, even when the writer just removed their own access. */
  private buildList(resource: ShareResource, callerRole: ResourceRole, requested: ShareResource = resource): ShareList {
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
    const list: ShareList = {
      resource,
      ownerUserId: this.ownerOf(resource) ?? HOST_OWNER_USER_ID,
      grants,
      callerRole,
      link: shareLink,
    }
    // A task that is itself shared reaches this resource; the dialog says so.
    const inherited = this.containingTasks(requested, resource).filter((task) => this.grantRows({ kind: 'task', id: task.taskId }).length > 0)
    if (inherited.length) list.inheritedFrom = inherited
    return list
  }

  /** Replaces every named row. The owner and editors may share; a viewer may not (§3.4).
   *  A row removed for a team or the organization names nobody: only a person's own row does. */
  setGrants(request: ShareSetRequest, principal: Principal): ShareList {
    const resource = this.canonical(request.resource)
    this.assertRole(principal, request.resource, 'editor')
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
    return this.buildList(resource, this.roleFor(principal, request.resource), request.resource)
  }

  /**
   * The link: one `everyone` row. A new secret is returned here and thereafter in the
   * share list to the owner and editors. Turning the link off or regenerating it
   * disconnects every guest at once (§3.4).
   */
  setLink(request: ShareSetLinkRequest, principal: Principal): ShareLink | null {
    const resource = this.canonical(request.resource)
    this.assertRole(principal, request.resource, 'editor')
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
