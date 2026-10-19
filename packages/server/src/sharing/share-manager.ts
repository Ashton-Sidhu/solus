import { afterDatabaseCommit } from '../db/database'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  resourceRoleAtLeast,
  shareNamedSubjectSchema,
  shareResourceKindSchema,
  shareRoleSchema,
  type ResourceRole,
  type ShareChangedEvent,
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
import type { Db } from '../db/database'
import { createLogger } from '../logger'
import { isHostAdmin, isHostOwner, isOrganizationSpace, organizationForNew, recordScopeOf, scopeAdmits, type Principal } from '../admission/principal'
import { actorFor, ownerKeyOf, type Actor } from '../admission/actor'
import { roleOf, visibleTo, type AccessResource, type AclEntry } from '../admission/access'
import { aclEntry } from './schema'
import { hostUserKey } from '../host/host-user'
import { LOCAL_ORGANIZATION_ID } from '../admission/principal'
import { sessionRecords } from '../data/sessions/schema'
import { claimSessionOwner, machineSessionHome, pendingSessionHome, type SessionHome } from '../data/sessions/session-records'
import { works } from '../data/works/schema'
import { tasks } from '../data/tasks/schema'
import { automationHomeOf } from '../data/automations/automations-store'
import { workspaceProjects } from '../projects/schema'
import { notifications } from '../data/notifications/schema'
import type { SharesMirrorPayload } from '../sync/runner-protocol'

const log = createLogger('main', 'share-manager')

/**
 * The ACL entries and links of sessions, works, and tasks
 * (docs/plans/access-model.md §2.2; docs/plans/cloud-sharing.md §4c). This file
 * owns every `acl_entry` row: what a resource's owner gave to a person, a team,
 * the organization, or everyone with the link. The owner itself is the
 * resource's `owner_key`, and `roleOf` (admission/access.ts) decides every role
 * from the two; nothing here decides one. The table is in the ported schema
 * (`./schema.ts`), so the same code answers on a host's SQLite and in the
 * Solus API's Postgres (docs/plans/cloud-service-model.md).
 */

/** Each shareable kind's table, and the column that holds its id. */
const RESOURCE_TABLES = {
  session: { table: sessionRecords, id: sql`session_id` },
  work: { table: works, id: sql`id` },
  task: { table: tasks, id: sql`id` },
} as const satisfies Record<ShareResourceKind, { table: unknown; id: SQL }>

const entryRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  resource_kind: z.enum(['session', 'work', 'task']),
  resource_id: z.string(),
  subject_kind: z.enum(['user', 'team', 'organization', 'everyone']),
  subject_id: z.string(),
  role: shareRoleSchema,
  link_secret_hash: z.string().nullable(),
  /** The secret itself, kept so the link is always at hand; null on a row made before the column existed. */
  link_secret: z.string().nullable(),
  granted_by_user_id: z.string(),
  created_at: z.number(),
})
type EntryRow = z.infer<typeof entryRowSchema>

const homeRowSchema = z.object({ owner_key: z.string(), organization_id: z.string() })
const accessRowSchema = z.object({ id: z.string(), owner_key: z.string(), organization_id: z.string() })
const idRowSchema = z.object({ id: z.string() })

/** What `roleOf` reads of one stored ACL entry. */
function aclEntryOf(row: EntryRow): AclEntry {
  return { subjectKind: row.subject_kind, subjectId: row.subject_id, role: row.role, organizationId: row.organization_id, linkSecretHash: row.link_secret_hash }
}

/**
 * Everything a role and a share list are computed from, read once per request.
 * A write updates it in place, so its answer needs no second read.
 */
interface ResourceAccess {
  resource: ShareResource
  /** The resource's owner and organization; null when there is no such resource. */
  home: SessionHome | null
  /** Its ACL entries, of every organization; `roleOf` holds them against the scope. */
  entries: EntryRow[]
}

/** The access of a resource that has a row: every share list and write needs its owner. */
type RecordedAccess = ResourceAccess & { home: SessionHome }

/**
 * The access, when the resource has a row. A session being started has a role
 * for its starter before its record exists, but no owner yet, so it has no
 * share list and takes no share until it is recorded.
 */
function withHome(access: ResourceAccess): RecordedAccess {
  const { home } = access
  if (!home) throw new ShareAccessError('NOT_FOUND', `This ${access.resource.kind} is not on this host`)
  return { ...access, home }
}

function linkRowOf(access: ResourceAccess): EntryRow | undefined {
  return access.entries.find((row) => row.subject_kind === 'everyone')
}

function byCreation(a: EntryRow, b: EntryRow): number {
  return a.created_at - b.created_at || a.id.localeCompare(b.id)
}

export class ShareAccessError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_SHARED' | 'HOST_NOT_LINKED', message: string) {
    super(message)
    this.name = 'ShareAccessError'
  }
}

/**
 * A task is not shared on its own (docs/plans/cloud-sharing.md §4a): its
 * organization sees it from the entry it is born with, and its link is the app's
 * address for it.
 */
function assertShareable(resource: ShareResource): void {
  if (resource.kind === 'task') throw new ShareAccessError('FORBIDDEN', 'A task is not shared. Everyone in its organization can open it; copy its link instead.')
}

export interface ResolvedLinkShare {
  organizationId: string
  resource: ShareResource
  role: ShareRole
  sharedByUserId: string
  linkSecretHash: string
}

/** What a share change means to connected clients; the transport and the publisher act on it. */
export interface ShareChange extends ShareChangedEvent {
  organizationId: string
  /** Who shared the resource with its whole organization in this change; the host records it as activity. */
  organizationSharedBy?: Actor
  /** The guest link was removed or regenerated: every guest socket on this resource ends now. */
  guestsRevoked: boolean
}

export interface ShareManagerDeps {
  db: Db
  /**
   * Whether this machine knows a session. A session nobody knows and nobody
   * claimed is being started right now: the access check runs before the first
   * request records its owner, so the person who names it may start it. A known
   * session with no record yet is the machine's own, as its record will say.
   * Without it (the Solus API) a session with no record does not exist.
   */
  sessionExists?: (sessionId: string) => boolean
  /**
   * The one-time assignment of a Local record to an organization
   * (organization-scope §3, R10). Answers the record's organization as it now
   * stands: the one asked for, or another it already had; null when there is no
   * record or the kind cannot be assigned here. Without it a Local record cannot
   * be shared with an organization.
   */
  assignOrganization?: (resource: ShareResource, organizationId: string) => Promise<string | null>
  /**
   * Whether `userId` was a member of `organizationId` and has left it, as the host's
   * organization standing says (plan 004 item 10). A host admin may then transfer
   * what they owned. Without it only the owner transfers.
   */
  hasLeftOrganization?: (organizationId: string, userId: string) => boolean
  /**
   * Whether a member can reach this host at all (docs/plans/host-sharing.md §4.3):
   * a host linked to Solus cloud, or the Solus API itself. A share with a person,
   * a team, or the organization on a host nobody can reach is refused, so the
   * record never moves into an organization that cannot open it. Without it,
   * members are assumed to reach the host.
   */
  membersReachable?: () => boolean
  now?: () => number
}

/** What the host says when a named share is asked of it while nobody but its owner can reach it. */
export const MEMBERS_CANNOT_REACH = 'Link this computer to Solus cloud so members can reach it, then share with them. Anyone with the link can still open it here.'

export function hashLinkSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** At most this many ids go into one `IN` list. */
const ID_CHUNK = 500

export class ShareManager {
  private readonly listeners = new Set<(change: ShareChange) => void>()

  constructor(private readonly deps: ShareManagerDeps) {}

  onChanged(listener: (change: ShareChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ── Owners ──────────────────────────────────────────────────────────────

  /** The resource's owner and organization, from its own row; null when there is no such resource. */
  async homeOf(resource: ShareResource): Promise<SessionHome | null> {
    const { table, id } = RESOURCE_TABLES[resource.kind]
    const row = homeRowSchema.nullish().parse(await this.deps.db.get(sql`
      SELECT owner_key, organization_id FROM ${table} WHERE ${id} = ${resource.id}
    `))
    if (row) return { ownerKey: row.owner_key, organizationId: row.organization_id }
    if (resource.kind !== 'session') return null
    return pendingSessionHome(resource.id) ?? (this.deps.sessionExists?.(resource.id) ? machineSessionHome() : null)
  }

  /**
   * The owner of each resource of a bounded page that passed `visibleTo`, and
   * the role the caller holds on it (docs/plans/access-model.md §2.7): `roleOf`
   * over its row and its ACL entries, read in one query each.
   */
  async accessOf(principal: Principal, kind: ShareResourceKind, ids: readonly string[]): Promise<Map<string, { ownerKey: string; role: ResourceRole }>> {
    if (ids.length === 0) return new Map()
    if (ids.length > 201) throw new Error('Role reads require a bounded resource page.')
    const { table, id } = RESOURCE_TABLES[kind]
    const listed = sql.join(ids.map((value) => sql`${value}`), sql`, `)
    const [rows, entries] = await Promise.all([
      accessRowSchema.array().parse(await this.deps.db.all(sql`
        SELECT ${id} AS id, owner_key, organization_id FROM ${table} WHERE ${id} IN (${listed})
      `)),
      entryRowSchema.array().parse(await this.deps.db.all(sql`
        SELECT * FROM ${aclEntry} WHERE resource_kind = ${kind} AND resource_id IN (${listed})
      `)),
    ])
    const actor = actorFor(principal)
    return new Map(rows.map((row) => [row.id, {
      ownerKey: row.owner_key,
      role: roleOf(actor, {
        kind, id: row.id, organizationId: row.organization_id, ownerKey: row.owner_key,
        acl: entries.filter((entry) => entry.resource_id === row.id).map(aclEntryOf),
      }),
    }]))
  }

  /**
   * The organization's ACL entry on a resource made in its space: editor
   * (decision 2026-09-16). The dialog offers one choice — who can open it —
   * with a viewer-or-editor role on each level; this is the role the first
   * level gets.
   */
  private async insertOrganizationEntry(db: Db, resource: ShareResource, organizationId: string, grantedBy: string): Promise<void> {
    await db.run(sql`
      INSERT INTO ${aclEntry} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
      VALUES (${randomUUID()}, ${resource.kind}, ${resource.id}, 'organization', ${organizationId}, 'editor', NULL, ${grantedBy}, ${this.now()}, ${organizationId})
      ON CONFLICT DO NOTHING
    `)
  }

  /**
   * The person who starts a session owns it (docs/plans/access-model.md §2.2):
   * the first claim before its record exists names the owner the record is
   * written with. A later call changes nothing, so every entry point may claim
   * freely. A session started in an organization's space also gets the
   * organization's editor entry; `shareWithOrganization: false` starts one
   * private in every space: a chat, which is its owner's own (docs/projects.md, "Chats").
   */
  async claimSession(sessionId: string, principal: Principal, options: { shareWithOrganization?: boolean } = {}): Promise<void> {
    const ownerKey = ownerKeyOf(actorFor(principal))
    if (!ownerKey || principal.kind === 'guest') return
    const claimed = await claimSessionOwner(sessionId, { ownerKey, organizationId: organizationForNew(principal) })
    if (claimed && options.shareWithOrganization !== false && isOrganizationSpace(principal)) {
      await this.insertOrganizationEntry(this.deps.db, { kind: 'session', id: sessionId }, principal.organizationId, ownerKey)
    }
  }

  /**
   * Give the organization the editor entry a new resource in its space starts
   * with: a work or a task just made, or a session claimed private before its
   * owner could decide — one watched before the prompt that names its folder.
   * Only the owner decides; a personal host's resources stay private.
   */
  async shareWithOrganization(resource: ShareResource, principal: Principal): Promise<void> {
    const ownerKey = ownerKeyOf(actorFor(principal))
    if (!ownerKey || !isOrganizationSpace(principal)) return
    if ((await this.homeOf(resource))?.ownerKey !== ownerKey) return
    await this.insertOrganizationEntry(this.deps.db, resource, principal.organizationId, ownerKey)
  }

  /**
   * A resource a runner wrote into the organization's Solus API
   * (cloud-service-model.md §16): its owner, the person whose delegated token
   * delivered it, is on its row. It is shared with the organization as editors
   * like anything made in the organization's space, unless it is a chat (plan 004 D14).
   */
  async shareRunnerWrite(resource: ShareResource, runner: Extract<Principal, { kind: 'runner' }>, ownerKey: string): Promise<void> {
    await this.insertOrganizationEntry(this.deps.db, resource, runner.organizationId, ownerKey)
  }

  /**
   * A new organization session admitted on a machine attached for organization
   * work (organization-vms §1): its record is born owned by the verified person
   * who started it (`SessionBirth`). Here only its ACL changes: an entry naming
   * that person would repeat the owner, and a project session gives the
   * organization's members the editor entry on the machine as they have on its
   * Solus API. A chat stays private until its owner shares it (plan 004 D14).
   * An entry of another organization is never touched.
   */
  async adoptForOrganization(resource: ShareResource, organizationId: string, ownerKey: string, options: { shareWithOrganization: boolean }): Promise<void> {
    const home = await this.homeOf(resource)
    if (home && home.organizationId !== LOCAL_ORGANIZATION_ID && home.organizationId !== organizationId) return
    await this.deps.db.transaction(async (db) => {
      await db.run(sql`
        DELETE FROM ${aclEntry}
        WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id} AND subject_kind = 'user' AND subject_id = ${ownerKey}
      `)
      if (options.shareWithOrganization) await this.insertOrganizationEntry(db, resource, organizationId, ownerKey)
    })
  }

  /**
   * The owner may hand a resource to another person: its `owner_key` changes. A
   * host admin may also hand on what a member who left the organization owned
   * (plan 004 item 10). The change is announced to everyone with access.
   */
  async transfer(request: ShareTransferRequest, principal: Principal): Promise<ShareList> {
    return this.deps.db.transaction(async (db) => {
      const access = withHome(await this.access(request.resource))
      const { resource, home } = access
      const previousOwner = home.ownerKey
      if (this.roleIn(principal, access) !== 'owner' && !this.mayTransferForDeparted(principal, home)) {
        throw new ShareAccessError('FORBIDDEN', 'Only the owner can transfer ownership')
      }
      // The new owner's own entry would repeat the owner.
      const named = access.entries.find((row) => row.subject_kind === 'user' && row.subject_id === request.toUserId)
      if (named) {
        await db.run(sql`DELETE FROM ${aclEntry} WHERE id = ${named.id}`)
        access.entries = access.entries.filter((row) => row !== named)
      }
      const { table, id } = RESOURCE_TABLES[resource.kind]
      await db.run(sql`UPDATE ${table} SET owner_key = ${request.toUserId} WHERE ${id} = ${resource.id}`)
      home.ownerKey = request.toUserId
      log.info('share_ownership_transferred', { kind: resource.kind, resourceId: resource.id, toUserId: request.toUserId })
      await this.announce(home.organizationId, access, principal, previousOwner !== request.toUserId ? [previousOwner] : [], false)
      return this.listOf(access, this.roleIn(principal, access))
    })
  }

  /** A host admin, in the resource's organization, whose owner has left it. */
  private mayTransferForDeparted(principal: Principal, home: SessionHome): boolean {
    if (!isHostAdmin(principal) || !this.deps.hasLeftOrganization) return false
    if (!scopeAdmits(recordScopeOf(principal), home.organizationId)) return false
    return this.deps.hasLeftOrganization(home.organizationId, home.ownerKey)
  }

  // ── Roles ───────────────────────────────────────────────────────────────

  /**
   * The role this principal holds on the resource, as `roleOf` decides it: the
   * one answer the gate and the event audience ask, for every kind a call names.
   */
  async roleFor(principal: Principal, resource: AccessResource): Promise<ResourceRole> {
    const kind = shareResourceKindSchema.safeParse(resource.kind)
    if (!kind.success) return this.ownedRoleFor(principal, resource)
    return this.roleIn(principal, await this.access({ kind: kind.data, id: resource.id }))
  }

  /**
   * The role on a resource that has no ACL entries (docs/plans/access-model.md
   * §2.3): from its own row, its owner and organization. A notification's owner
   * is its recipient. A resource that does not exist gives no role.
   */
  private async ownedRoleFor(principal: Principal, resource: AccessResource): Promise<ResourceRole> {
    const home = await this.ownedHomeOf(resource)
    if (!home) return principal.kind === 'system' ? 'owner' : 'none'
    return roleOf(actorFor(principal), { kind: resource.kind, id: resource.id, organizationId: home.organizationId, ownerKey: home.ownerKey, acl: [] })
  }

  private async ownedHomeOf(resource: AccessResource): Promise<SessionHome | null> {
    switch (resource.kind) {
      case 'automation':
        return automationHomeOf(resource.id)
      case 'project':
      case 'notification': {
        const row = homeRowSchema.nullish().parse(await this.deps.db.get(resource.kind === 'project'
          ? sql`SELECT owner_key, organization_id FROM ${workspaceProjects} WHERE id = ${resource.id}`
          : sql`SELECT recipient_key AS owner_key, organization_id FROM ${notifications} WHERE id = ${resource.id}`))
        return row ? { ownerKey: row.owner_key, organizationId: row.organization_id } : null
      }
      default:
        // An integration and an insight are not named by a call: their handlers ask `roleOf` with the row in hand.
        return null
    }
  }

  /** The resource's row and ACL entries, in one read each. */
  private async access(resource: ShareResource): Promise<ResourceAccess> {
    const [home, entries] = await Promise.all([this.homeOf(resource), this.entries(resource)])
    return { resource, home, entries }
  }

  /**
   * The role `access` gives this principal; it reads nothing, so a write can ask
   * again after it changes `access`. A resource that does not exist gives no
   * role, but for one case: a session nobody knows or claimed is being started
   * by the person who names it, a host owner or a member. The handler records
   * them as its owner before anyone else can name it.
   */
  private roleIn(principal: Principal, access: ResourceAccess): ResourceRole {
    const actor = actorFor(principal)
    const { resource, home } = access
    if (!home) {
      if (principal.kind === 'system') return 'owner'
      const starts = resource.kind === 'session' && this.deps.sessionExists?.(resource.id) === false
      return starts && (isHostOwner(principal) || principal.kind === 'org-member') ? 'owner' : 'none'
    }
    return roleOf(actor, {
      kind: resource.kind,
      id: resource.id,
      organizationId: home.organizationId,
      ownerKey: home.ownerKey,
      acl: access.entries.map(aclEntryOf),
    })
  }

  /**
   * Filters a listing to what the caller may open: `visibleTo` over the
   * resources' own rows, so a list and a get cannot disagree. List RPCs never
   * return an id the caller cannot open.
   */
  async filterVisible<T>(principal: Principal, kind: ShareResourceKind, items: T[], idOf: (item: T) => string): Promise<T[]> {
    if (principal.kind === 'system') return items
    const ids = [...new Set(items.map(idOf))]
    const { table, id } = RESOURCE_TABLES[kind]
    const predicate = visibleTo(actorFor(principal), kind, { id: sql`${table}.${id}`, organization: sql`${table}.organization_id`, owner: sql`${table}.owner_key` })
    const visible = new Set<string>()
    for (let start = 0; start < ids.length; start += ID_CHUNK) {
      const chunk = ids.slice(start, start + ID_CHUNK)
      const rows = idRowSchema.array().parse(await this.deps.db.all(sql`
        SELECT ${table}.${id} AS id FROM ${table}
        WHERE ${table}.${id} IN (${sql.join(chunk.map((value) => sql`${value}`), sql`, `)}) AND ${predicate}
      `))
      for (const row of rows) visible.add(row.id)
    }
    return items.filter((item) => visible.has(idOf(item)))
  }

  // ── The share list ──────────────────────────────────────────────────────

  async list(resourceInput: ShareResource, principal: Principal): Promise<ShareList> {
    const access = await this.access(resourceInput)
    const callerRole = this.roleIn(principal, access)
    if (callerRole === 'none') throw new ShareAccessError('FORBIDDEN', `This ${access.resource.kind} is not shared with you`)
    return this.listOf(withHome(access), callerRole)
  }

  /** The list `access` describes. A write answers with it as it now stands, even when the writer just removed their own access. */
  private listOf(access: RecordedAccess, callerRole: ResourceRole): ShareList {
    const link = linkRowOf(access)
    const entries: ShareList['entries'] = access.entries
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
      resource: access.resource,
      ownerKey: access.home.ownerKey,
      entries,
      callerRole,
      link: shareLink,
    }
  }

  /**
   * Replaces every named row, and the link too when the request names it, in one
   * transaction: a scope change is one call, and the list never lands between two
   * scopes. The owner and editors may share; a viewer may not (§3.4). A row
   * removed for a team or the organization names nobody: only a person's own row
   * does. The owner needs no entry; a named row for them is ignored.
   */
  async setEntries(request: ShareSetRequest, principal: Principal): Promise<ShareList> {
    assertShareable(request.resource)
    if (request.entries.length > 0 && this.deps.membersReachable?.() === false) throw new ShareAccessError('HOST_NOT_LINKED', MEMBERS_CANNOT_REACH)
    await this.joinNamedOrganization(request, principal)
    return this.deps.db.transaction(async (db) => {
      const access = withHome(await this.access(request.resource))
      this.assertEditor(principal, access)
      const { resource } = access
      const organizationId = access.home.organizationId
      const grantedBy = ownerKeyOf(actorFor(principal)) ?? hostUserKey()
      const next = new Map<string, { subject: ShareNamedSubject; role: ShareRole }>()
      for (const entry of request.entries) {
        const subject = shareNamedSubjectSchema.parse(entry.subject)
        if (subject.kind === 'user' && subject.id === access.home.ownerKey) continue
        next.set(`${subject.kind}:${subject.id}`, { subject, role: entry.role })
      }
      const before = new Map(access.entries.filter((row) => row.subject_kind !== 'everyone').map((row) => [`${row.subject_kind}:${row.subject_id}`, row]))
      const removed = [...before.entries()].filter(([key]) => !next.has(key)).map(([, row]) => row)
      if (removed.length) {
        await db.run(sql`DELETE FROM ${aclEntry} WHERE id IN (${sql.join(removed.map((row) => sql`${row.id}`), sql`, `)})`)
      }
      const now = this.now()
      const kept: EntryRow[] = []
      const added: EntryRow[] = []
      for (const [key, { subject, role }] of next) {
        const existing = before.get(key)
        if (!existing) {
          added.push({ id: randomUUID(), organization_id: organizationId, resource_kind: resource.kind, resource_id: resource.id, subject_kind: subject.kind, subject_id: subject.id, role, link_secret_hash: null, link_secret: null, granted_by_user_id: grantedBy, created_at: now })
          continue
        }
        if (existing.role !== role) await db.run(sql`UPDATE ${aclEntry} SET role = ${role} WHERE id = ${existing.id}`)
        kept.push({ ...existing, role })
      }
      if (added.length) {
        await db.run(sql`
          INSERT INTO ${aclEntry} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
          VALUES ${sql.join(added.map((row) => sql`(${row.id}, ${row.resource_kind}, ${row.resource_id}, ${row.subject_kind}, ${row.subject_id}, ${row.role}, NULL, ${row.granted_by_user_id}, ${row.created_at}, ${row.organization_id})`), sql`, `)}
        `)
      }
      const linkRow = linkRowOf(access)
      access.entries = [...kept, ...added, ...(linkRow ? [linkRow] : [])].sort(byCreation)
      const removedUserIds = removed.filter((row) => row.subject_kind === 'user').map((row) => row.subject_id)
      log.info('share_grants_set', { kind: resource.kind, resourceId: resource.id, grants: next.size, removed: removedUserIds.length })
      const link = request.link ? await this.writeLink(access, request.link.role, false, organizationId, grantedBy) : null
      const held = await this.holdOrganizationAtLink(db, access, grantedBy)
      const sharedWithOrganization = held === 'added' || [...next.values()].some(({ subject }) => subject.kind === 'organization' && !before.has(`organization:${subject.id}`))
      await this.announce(organizationId, access, principal, removedUserIds, link?.guestsRevoked ?? false, sharedWithOrganization)
      return this.listOf(access, this.roleIn(principal, access))
    })
  }

  /**
   * Sharing a record with an organization puts it in that organization
   * (organization-scope §3): a member is admitted only to records of their own
   * organization, so a Local record shared with "everyone in X" must become X's,
   * or no member of X could open it. The assignment is the one-time move from
   * Local; a record that already belongs to another organization is refused.
   * The share rows written while it was Local follow it.
   */
  private async joinNamedOrganization(request: ShareSetRequest, principal: Principal): Promise<void> {
    const named = request.entries.find((entry) => entry.subject.kind === 'organization')?.subject.id
    if (!named) return
    const access = await this.access(request.resource)
    this.assertEditor(principal, access)
    const current = access.home?.organizationId ?? null
    if (current === named) return
    if (current !== null && current !== LOCAL_ORGANIZATION_ID) {
      throw new ShareAccessError('FORBIDDEN', `This ${request.resource.kind} belongs to another organization`)
    }
    const assigned = await this.deps.assignOrganization?.(request.resource, named) ?? null
    if (assigned !== named) {
      throw new ShareAccessError('FORBIDDEN', `This ${request.resource.kind} cannot be shared with that organization`)
    }
    await this.followRecordOrganization(request.resource, named)
  }

  /**
   * The record moved from Local into an organization (organization-scope §3, R10):
   * its ACL entries written while it was Local move with it, so every entry
   * names the record's one organization. Rows of any other
   * organization are never touched.
   */
  async followRecordOrganization(resource: ShareResource, organizationId: string): Promise<void> {
    if (organizationId === LOCAL_ORGANIZATION_ID) return
    const moved = await this.deps.db.run(sql`
      UPDATE ${aclEntry} SET organization_id = ${organizationId}
      WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id} AND organization_id = ${LOCAL_ORGANIZATION_ID}
    `)
    if (moved.changes > 0) log.info('share_rows_followed_record', { kind: resource.kind, resourceId: resource.id, organizationId, rows: moved.changes })
  }

  /**
   * The link alone: one `everyone` row. It answers the link as it now stands, with
   * its secret, to the owner and editors. Turning the link off or regenerating it
   * disconnects every guest at once (§3.4).
   */
  async setLink(request: ShareSetLinkRequest, principal: Principal): Promise<ShareLink | null> {
    assertShareable(request.resource)
    return this.deps.db.transaction(async () => {
      const access = withHome(await this.access(request.resource))
      this.assertEditor(principal, access)
      const organizationId = access.home.organizationId
      const grantedBy = ownerKeyOf(actorFor(principal)) ?? hostUserKey()
      const change = await this.writeLink(access, request.role, request.regenerate === true, organizationId, grantedBy)
      const held = await this.holdOrganizationAtLink(this.deps.db, access, grantedBy)
      if (change.changed || held) await this.announce(organizationId, access, principal, [], change.guestsRevoked, held === 'added')
      return change.link
    })
  }

  /**
   * The link is the widest scope: a member of the resource's organization never
   * holds less than a stranger with its link. The link entry admits only guests, and
   * a member reaches the resource through the organization's entry, so that entry is
   * raised to the link's role, or made with it, whenever the link or the entries are
   * written. Every client gets this, whatever it sends. A Local record has no
   * organization, and a host members cannot reach gets no entry they could not use.
   */
  private async holdOrganizationAtLink(db: Db, access: RecordedAccess, grantedBy: string): Promise<'added' | 'raised' | null> {
    const link = linkRowOf(access)
    const organizationId = access.home.organizationId
    if (!link || organizationId === LOCAL_ORGANIZATION_ID || this.deps.membersReachable?.() === false) return null
    const { resource } = access
    const entry = access.entries.find((row) => row.subject_kind === 'organization' && row.subject_id === organizationId)
    if (entry) {
      if (resourceRoleAtLeast(entry.role, link.role)) return null
      await db.run(sql`UPDATE ${aclEntry} SET role = ${link.role} WHERE id = ${entry.id}`)
      entry.role = link.role
      log.info('share_organization_held_at_link', { kind: resource.kind, resourceId: resource.id, role: link.role, added: false })
      return 'raised'
    }
    const row: EntryRow = { id: randomUUID(), organization_id: organizationId, resource_kind: resource.kind, resource_id: resource.id, subject_kind: 'organization', subject_id: organizationId, role: link.role, link_secret_hash: null, link_secret: null, granted_by_user_id: grantedBy, created_at: this.now() }
    await db.run(sql`
      INSERT INTO ${aclEntry} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
      VALUES (${row.id}, ${row.resource_kind}, ${row.resource_id}, 'organization', ${organizationId}, ${row.role}, NULL, ${grantedBy}, ${row.created_at}, ${organizationId})
    `)
    access.entries = [...access.entries, row].sort(byCreation)
    log.info('share_organization_held_at_link', { kind: resource.kind, resourceId: resource.id, role: link.role, added: true })
    return 'added'
  }

  private assertEditor(principal: Principal, access: ResourceAccess): void {
    if (!resourceRoleAtLeast(this.roleIn(principal, access), 'editor')) {
      throw new ShareAccessError('FORBIDDEN', `This ${access.resource.kind} is not shared with you`)
    }
  }

  /**
   * Writes the link row and updates `access` to match. A new secret is made when
   * there was no link or `regenerate` asks; a role change alone keeps the secret,
   * so its guests stay connected with the new role.
   */
  private async writeLink(
    access: ResourceAccess,
    role: ShareRole | null,
    regenerate: boolean,
    organizationId: string,
    grantedBy: string,
  ): Promise<{ changed: boolean; guestsRevoked: boolean; link: ShareLink | null }> {
    const { resource } = access
    const existing = linkRowOf(access)
    const db = this.deps.db
    if (role === null) {
      if (!existing) return { changed: false, guestsRevoked: false, link: null }
      await db.run(sql`DELETE FROM ${aclEntry} WHERE id = ${existing.id}`)
      access.entries = access.entries.filter((row) => row !== existing)
      log.info('share_link_removed', { kind: resource.kind, resourceId: resource.id })
      return { changed: true, guestsRevoked: true, link: null }
    }
    if (existing && !regenerate) {
      const changed = existing.role !== role
      if (changed) await db.run(sql`UPDATE ${aclEntry} SET role = ${role} WHERE id = ${existing.id}`)
      existing.role = role
      log.info('share_link_set', { kind: resource.kind, resourceId: resource.id, role, rotated: false })
      return { changed, guestsRevoked: false, link: existing.link_secret ? { role, secret: existing.link_secret } : null }
    }
    const secret = randomBytes(32).toString('base64url')
    const row: EntryRow = existing
      ? { ...existing, role, link_secret_hash: hashLinkSecret(secret), link_secret: secret, granted_by_user_id: grantedBy }
      : { id: randomUUID(), organization_id: organizationId, resource_kind: resource.kind, resource_id: resource.id, subject_kind: 'everyone', subject_id: '', role, link_secret_hash: hashLinkSecret(secret), link_secret: secret, granted_by_user_id: grantedBy, created_at: this.now() }
    await db.run(existing
      ? sql`UPDATE ${aclEntry} SET role = ${role}, link_secret_hash = ${row.link_secret_hash}, link_secret = ${secret}, granted_by_user_id = ${grantedBy} WHERE id = ${existing.id}`
      : sql`
        INSERT INTO ${aclEntry} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, link_secret, granted_by_user_id, created_at, organization_id)
        VALUES (${row.id}, ${row.resource_kind}, ${row.resource_id}, 'everyone', '', ${role}, ${row.link_secret_hash}, ${secret}, ${grantedBy}, ${row.created_at}, ${row.organization_id})
      `)
    access.entries = [...access.entries.filter((entry) => entry !== existing), row].sort(byCreation)
    log.info('share_link_set', { kind: resource.kind, resourceId: resource.id, role, rotated: true })
    // A regenerated secret ends the old guests.
    return { changed: true, guestsRevoked: !!existing, link: { role, secret } }
  }

  /** Admission: the secret names one resource and one role, or nothing. The hash
   *  is unique across the database, so the lookup needs no organization. */
  async resolveLinkSecret(secret: string): Promise<ResolvedLinkShare | null> {
    const hash = hashLinkSecret(secret)
    const row = entryRowSchema.nullish().parse(await this.deps.db.get(sql`
      SELECT * FROM ${aclEntry} WHERE subject_kind = 'everyone' AND link_secret_hash = ${hash}
    `))
    // A task link made before tasks stopped being shared opens nothing.
    if (!row || row.resource_kind === 'task') return null
    return {
      organizationId: row.organization_id,
      resource: { kind: row.resource_kind, id: row.resource_id },
      role: row.role,
      sharedByUserId: row.granted_by_user_id,
      linkSecretHash: hash,
    }
  }

  // ── The mirror (docs/plans/host-sharing.md §2) ──────────────────────────

  /**
   * The resource's ACL entries, as the host that runs it sends them up.
   * The link goes as its hash: the API admits a guest with it and never copies the
   * secret itself.
   */
  async mirroredRows(resource: ShareResource): Promise<SharesMirrorPayload['rows']> {
    return (await this.entries(resource)).map((row) => ({
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      role: row.role,
      linkSecretHash: row.link_secret_hash,
      grantedByUserId: row.granted_by_user_id,
      createdAt: row.created_at,
    }))
  }

  /**
   * The mirror's sink on the Solus API: the host's entries replace every entry
   * of the resource in its organization; the owner is the record's own. A link whose hash changed or went ends
   * the guests it admitted here, as a change made here would.
   */
  async applyMirroredRows(organizationId: string, payload: SharesMirrorPayload): Promise<void> {
    const { resource, rows } = payload
    await this.deps.db.transaction(async (db) => {
      const before = (await this.entries(resource)).find((row) => row.subject_kind === 'everyone')
      await db.run(sql`
        DELETE FROM ${aclEntry}
        WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id} AND organization_id = ${organizationId}
      `)
      for (const row of rows) {
        await db.run(sql`
          INSERT INTO ${aclEntry} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, link_secret, granted_by_user_id, created_at, organization_id)
          VALUES (${randomUUID()}, ${resource.kind}, ${resource.id}, ${row.subjectKind}, ${row.subjectId}, ${row.role}, ${row.linkSecretHash}, NULL, ${row.grantedByUserId}, ${row.createdAt}, ${organizationId})
          ON CONFLICT DO NOTHING
        `)
      }
      const after = rows.find((row) => row.subjectKind === 'everyone')
      const guestsRevoked = !!before && (!after || after.linkSecretHash !== before.link_secret_hash)
      const change: ShareChange = { organizationId, resource, removedUserIds: [], guestsRevoked }
      log.info('share_rows_mirrored', { kind: resource.kind, resourceId: resource.id, organizationId, rows: rows.length, guestsRevoked })
      await afterDatabaseCommit(async () => {
        for (const listener of this.listeners) {
          try { listener(change) } catch (error) {
            log.warn('share_change_listener_failed', { error: error instanceof Error ? error.message : String(error) })
          }
        }
      })
    })
  }

  /** Removes every ACL entry when a resource is deleted. */
  async forget(resource: ShareResource): Promise<void> {
    await this.deps.db.run(sql`
      DELETE FROM ${aclEntry}
      WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id}
    `)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Every ACL entry of one resource, of every organization, in one read: `roleOf` holds them against the scope. */
  private async entries(resource: ShareResource): Promise<EntryRow[]> {
    return entryRowSchema.array().parse(await this.deps.db.all(sql`
      SELECT * FROM ${aclEntry}
      WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id}
      ORDER BY created_at, id
    `))
  }

  private async announce(
    organizationId: string,
    access: ResourceAccess,
    principal: Principal,
    removedUserIds: string[],
    guestsRevoked: boolean,
    sharedWithOrganization = false,
  ): Promise<void> {
    const actor = actorFor(principal)
    const changedBy = actor.user
    const change: ShareChange = {
      organizationId,
      resource: access.resource,
      removedUserIds,
      guestsRevoked,
    }
    if (changedBy) change.changedBy = changedBy
    if (sharedWithOrganization && changedBy) change.organizationSharedBy = actor
    await afterDatabaseCommit(async () => {
      for (const listener of this.listeners) {
        try { listener(change) } catch (error) {
          log.warn('share_change_listener_failed', { error: error instanceof Error ? error.message : String(error) })
        }
      }
    })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
