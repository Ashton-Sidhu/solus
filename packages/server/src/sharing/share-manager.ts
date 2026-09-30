import { afterDatabaseCommit } from '../db/database'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  higherResourceRole,
  resourceRoleAtLeast,
  shareNamedSubjectSchema,
  shareRoleSchema,
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
import type { Db } from '../db/database'
import { createLogger } from '../logger'
import { isHostAdmin, isHostOwner, isOrganizationSpace, organizationForNew, recordScopeOf, scopeAdmits, type Principal } from '../admission/principal'
import { actorFor, ownerKeyOf, type Actor } from '../admission/actor'
import { resourceOwner, shareGrant } from './schema'
import { hostUserKey } from '../host/host-user'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID, type RecordScope } from '../admission/principal'
import { scopeClause } from '../data/scope'

const log = createLogger('main', 'share-manager')

/**
 * What a resource starts with on a managed host (decision 2026-09-16): the
 * organization, as editors. The dialog offers one choice — who can open it — with
 * a viewer-or-editor role on each level; this is the role the first level gets.
 */
const SCOPE_ROLE: ShareRole = 'editor'

/**
 * Who may open which session, work, or task
 * (docs/plans/multiplayer-sharing.md §3.4). This file owns every row it reads: the
 * owner of each resource and the share list. Nothing else joins these tables. Both
 * live in the ported schema (`./schema.ts`), so the same code answers on a host's
 * SQLite and in the cloud's Postgres, where every row is scoped to the
 * organization the caller's principal names (docs/plans/cloud-service-model.md).
 *
 * Ownership is recorded here rather than on the `sessions` and `works` rows because a
 * session's index row is rewritten by the transcript indexer. One table, one key
 * `(kind, id)`, covers every kind.
 *
 * A resource's canonical organization lives on its own record (organization-scope
 * §3); the rows here carry a copy for the Solus API's per-organization reads. A
 * member reaches a resource only when their scope admits its organization and a
 * row names them; the owner of a personal host reaches everything on the disk.
 */

const grantRowSchema = z.object({
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
type GrantRow = z.infer<typeof grantRowSchema>

const ownerRowWithOrganizationSchema = z.object({ owner_user_id: z.string(), organization_id: z.string() })
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
   * A session is addressed by its stable Solus id, but some calls carry a provider
   * thread id. The lineage table maps one to the other; identity when it has no row.
   */
  canonicalSessionId?: (sessionId: string) => string
  /**
   * A task's share reaches what is linked to it (§3.4): the sessions and works of
   * the named tasks, and the tasks a session or work is linked to. The tasks domain
   * answers both; without it a task shares only its own page.
   */
  taskContents?: (scope: RecordScope, taskIds: readonly string[]) => Promise<ShareResource[]>
  containingTasks?: (scope: RecordScope, resource: ShareResource) => Promise<ContainingTask[]>
  /**
   * Whether the host has any record of a session. A session nobody has recorded
   * yet is new, and the member starting it may: the access check runs before the
   * first prompt claims ownership. Without it every unowned session is closed.
   */
  sessionExists?: (sessionId: string) => boolean
  /**
   * The canonical organization of a resource (organization-scope §3): the session
   * record's, the work row's, the task row's. Null when the record does not exist
   * yet — a session claimed at its first watch. Without it every resource is
   * treated as the creating principal's.
   */
  organizationOfResource?: (resource: ShareResource) => Promise<string | null>
  /**
   * Whether `userId` was a member of `organizationId` and has left it, as the host's
   * organization standing says (plan 004 item 10). A host admin may then transfer
   * what they owned. Without it only the owner transfers.
   */
  hasLeftOrganization?: (organizationId: string, userId: string) => boolean
  now?: () => number
}

export function hashLinkSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export class ShareManager {
  private readonly listeners = new Set<(change: ShareChange) => void>()

  constructor(private readonly deps: ShareManagerDeps) {}

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

  async ownerOf(resource: ShareResource): Promise<string | null> {
    return (await this.ownerRow(resource))?.owner_user_id ?? null
  }

  /** Owner metadata for a bounded page that has already passed resource visibility. */
  async ownersOf(kind: ShareResourceKind, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map()
    if (ids.length > 201) throw new Error('Owner reads require a bounded resource page.')
    const rows = z.array(z.object({ resource_id: z.string(), owner_user_id: z.string() })).parse(await this.deps.db.all(sql`
      SELECT resource_id, owner_user_id FROM ${resourceOwner}
      WHERE resource_kind = ${kind} AND resource_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
    `))
    return new Map(rows.map(row => [row.resource_id, row.owner_user_id]))
  }

  private async ownerRow(resource: ShareResource): Promise<{ owner_user_id: string; organization_id: string } | null> {
    const canonical = this.canonical(resource)
    return ownerRowWithOrganizationSchema.nullish().parse(await this.deps.db.get(sql`
      SELECT owner_user_id, organization_id FROM ${resourceOwner}
      WHERE resource_kind = ${canonical.kind} AND resource_id = ${canonical.id}
    `)) ?? null
  }

  /** The organization a resource's rows are written under: the record's own, else the principal's. */
  private async organizationOf(canonical: ShareResource, principal: Principal): Promise<string> {
    return await this.deps.organizationOfResource?.(canonical) ?? organizationForNew(principal)
  }

  /** Whether the principal's scope admits the resource's organization; a resource with no record yet is admitted. */
  private async scopeAdmitsResource(principal: Principal, canonical: ShareResource): Promise<boolean> {
    const organizationId = await this.deps.organizationOfResource?.(canonical)
    return organizationId === null || organizationId === undefined || scopeAdmits(recordScopeOf(principal), organizationId)
  }

  /**
   * The first principal to start a session or create a work owns it. A later call
   * for the same resource changes nothing, so every entry point may claim freely.
   *
   * A resource made on a managed host or the organization's workspace service
   * starts shared with the organization: the space is the team's, so its work is
   * visible to the team until the owner narrows it. A personal host's resources
   * start private. `shareWithOrganization: false` starts one private in every
   * space: a chat, whose folder is the owner's own (Scratchpad decision S5).
   */
  async claimOwner(
    resource: ShareResource,
    principal: Principal,
    options: { shareWithOrganization?: boolean } = {},
  ): Promise<string | null> {
    const ownerUserId = ownerKeyOf(actorFor(principal))
    if (!ownerUserId) return this.ownerOf(resource)
    const canonical = this.canonical(resource)
    const organizationId = await this.organizationOf(canonical, principal)
    const inserted = await this.deps.db.run(sql`
      INSERT INTO ${resourceOwner} (resource_kind, resource_id, owner_user_id, created_at, organization_id)
      VALUES (${canonical.kind}, ${canonical.id}, ${ownerUserId}, ${this.now()}, ${organizationId})
      ON CONFLICT(resource_kind, resource_id) DO NOTHING
    `)
    if (inserted.changes > 0 && options.shareWithOrganization !== false) await this.shareWithOrganization(canonical, principal)
    // A resource another organization owns is not this caller's to see: the claim changed nothing and answers nothing.
    const row = await this.ownerRow(canonical)
    if (!row || !scopeAdmits(recordScopeOf(principal), row.organization_id)) return null
    return row.owner_user_id
  }

  /**
   * Give the organization the grant a new resource in its space starts with. For a
   * resource claimed private before its owner could decide — a session watched
   * before the prompt that names its folder. Only the owner decides; a personal
   * host's resources stay private.
   */
  async shareWithOrganization(resource: ShareResource, principal: Principal): Promise<void> {
    const ownerUserId = ownerKeyOf(actorFor(principal))
    if (!ownerUserId || !isOrganizationSpace(principal)) return
    const canonical = this.canonical(resource)
    const organizationId = await this.organizationOf(canonical, principal)
    if (await this.ownerOf(canonical) !== ownerUserId) return
    await this.deps.db.run(sql`
      INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
      VALUES (${randomUUID()}, ${canonical.kind}, ${canonical.id}, 'organization', ${principal.organizationId}, ${SCOPE_ROLE}, NULL, ${ownerUserId}, ${this.now()}, ${organizationId})
      ON CONFLICT(resource_kind, resource_id, subject_kind, subject_id) DO NOTHING
    `)
  }

  /**
   * A resource a runner's op wrote into the organization's workspace
   * (cloud-service-model.md §16): owned by the person whose delegated token
   * delivered it (a runner always acts for one), and shared with the
   * organization as editors like anything made in the organization's space, unless
   * it is a chat (plan 004 D14). A resource that already has an owner is left as it is.
   */
  async claimForRunner(resource: ShareResource, runner: Extract<Principal, { kind: 'runner' }>, options: { shareWithOrganization: boolean } = { shareWithOrganization: true }): Promise<void> {
    const organizationId = runner.organizationId
    const canonical = this.canonical(resource)
    const ownerUserId = runner.ownerUserId
    const inserted = await this.deps.db.run(sql`
      INSERT INTO ${resourceOwner} (resource_kind, resource_id, owner_user_id, created_at, organization_id)
      VALUES (${canonical.kind}, ${canonical.id}, ${ownerUserId}, ${this.now()}, ${organizationId})
      ON CONFLICT(resource_kind, resource_id) DO NOTHING
    `)
    if (inserted.changes === 0 || !options.shareWithOrganization) return
    await this.deps.db.run(sql`
      INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
      VALUES (${randomUUID()}, ${canonical.kind}, ${canonical.id}, 'organization', ${organizationId}, ${SCOPE_ROLE}, NULL, ${ownerUserId}, ${this.now()}, ${organizationId})
      ON CONFLICT(resource_kind, resource_id, subject_kind, subject_id) DO NOTHING
    `)
  }

  /**
   * A new organization session admitted on a machine attached for organization work
   * (organization-vms §1): the verified person who started it owns it, in its
   * organization. A project session also gives the organization's members the
   * editor grant on the machine as they do on its Solus API — shared compute, access
   * on the record. A chat stays private until its owner shares it (plan 004 D14).
   * It gives no role on the machine itself. A claim an earlier watch made for the
   * not-yet-admitted session is replaced; a row of another organization is never
   * touched. Called once, at admission, before the provider starts.
   */
  async adoptForOrganization(resource: ShareResource, organizationId: string, ownerUserId: string, options: { shareWithOrganization: boolean }): Promise<void> {
    const canonical = this.canonical(resource)
    await this.deps.db.transaction(async (db) => {
      await db.run(sql`
        INSERT INTO ${resourceOwner} (resource_kind, resource_id, owner_user_id, created_at, organization_id)
        VALUES (${canonical.kind}, ${canonical.id}, ${ownerUserId}, ${this.now()}, ${organizationId})
        ON CONFLICT(resource_kind, resource_id) DO UPDATE SET owner_user_id = excluded.owner_user_id, organization_id = excluded.organization_id
        WHERE resource_owner.organization_id IN (${LOCAL_ORGANIZATION_ID}, excluded.organization_id)
      `)
      if (!options.shareWithOrganization) return
      await db.run(sql`
        INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
        VALUES (${randomUUID()}, ${canonical.kind}, ${canonical.id}, 'organization', ${organizationId}, ${SCOPE_ROLE}, NULL, ${ownerUserId}, ${this.now()}, ${organizationId})
        ON CONFLICT(resource_kind, resource_id, subject_kind, subject_id) DO NOTHING
      `)
    })
  }

  /**
   * The owner may hand a resource to another member. A host admin may also hand on
   * what a member who left the organization owned (plan 004 item 10). The change is
   * announced to everyone with access.
   */
  async transfer(request: ShareTransferRequest, principal: Principal): Promise<ShareList> {
    return this.deps.db.transaction(async () => {
      const resource = this.canonical(request.resource)
      const organizationId = await this.organizationOf(resource, principal)
      const previousOwner = await this.ownerOf(resource)
      if (await this.roleFor(principal, request.resource) !== 'owner' && !await this.mayTransferForDeparted(principal, resource, organizationId, previousOwner)) {
        throw new ShareAccessError('FORBIDDEN', 'Only the owner can transfer ownership')
      }
      await this.deps.db.run(sql`
        INSERT INTO ${resourceOwner} (resource_kind, resource_id, owner_user_id, created_at, organization_id)
        VALUES (${resource.kind}, ${resource.id}, ${request.toUserId}, ${this.now()}, ${organizationId})
        ON CONFLICT(resource_kind, resource_id) DO UPDATE SET owner_user_id = excluded.owner_user_id
      `)
      log.info('share_ownership_transferred', { kind: resource.kind, resourceId: resource.id, toUserId: request.toUserId })
      await this.announce(organizationId, resource, principal, previousOwner && previousOwner !== request.toUserId ? [previousOwner] : [], false)
      return this.buildList(resource, await this.roleFor(principal, request.resource), request.resource)
    })
  }

  /** A host admin, in the resource's organization, whose owner has left it. */
  private async mayTransferForDeparted(principal: Principal, resource: ShareResource, organizationId: string, owner: string | null): Promise<boolean> {
    if (!owner || !isHostAdmin(principal) || !this.deps.hasLeftOrganization) return false
    if (!scopeAdmits(recordScopeOf(principal), organizationId) || !await this.scopeAdmitsResource(principal, resource)) return false
    return this.deps.hasLeftOrganization(organizationId, owner)
  }

  // ── Roles ───────────────────────────────────────────────────────────────

  /**
   * The highest role this principal holds on the resource (§3.4, §3.5). A session
   * or work also holds what the tasks it is linked to give, short of ownership: a
   * task shared with someone shares everything in it.
   */
  async roleFor(principal: Principal, resource: ShareResource): Promise<ResourceRole> {
    const canonical = this.canonical(resource)
    if (principal.kind === 'system') return 'owner'
    // The host's owner holds every role on what their scope reaches: the whole disk,
    // or only its Local records for a pairing connection to an attached machine.
    if (isHostOwner(principal)) return await this.scopeAdmitsResource(principal, canonical) ? 'owner' : 'none'
    // A runner holds no role on anything; its writes go through the system-only methods.
    if (principal.kind === 'runner') return 'none'
    // A record of another organization is not this member's to see, whatever the rows say (§3).
    if (!await this.scopeAdmitsResource(principal, canonical)) return 'none'
    const scope = recordScopeOf(principal)
    if (principal.kind === 'guest') {
      const bound = this.canonical(principal.share.resource)
      const reaches = sameResource(bound, canonical)
        || (bound.kind === 'task' && (await this.taskContents(scope, [bound.id])).some((item) => sameResource(item, canonical)))
      if (!reaches) return 'none'
      // The link the guest arrived with must still exist unchanged, in the guest's organization.
      const row = (await this.grantRows(bound, scope)).find((grant) => grant.subject_kind === 'everyone')
      if (!row || row.link_secret_hash !== principal.share.linkSecretHash) return 'none'
      return row.role
    }
    let role = await this.ownRoleFor(principal, canonical)
    for (const task of await this.containingTasks(scope, resource, canonical)) {
      if (role === 'owner') break
      role = higherResourceRole(role, inheritedRole(await this.ownRoleFor(principal, { kind: 'task', id: task.taskId })))
    }
    return role
  }

  /** A member's standing on one resource from its owner record and its own rows alone. */
  private async ownRoleFor(principal: Extract<Principal, { kind: 'org-member' }>, canonical: ShareResource): Promise<ResourceRole> {
    const ownerRow = await this.ownerRow(canonical)
    // A resource another organization's rows own is not this member's, whatever else says so.
    if (ownerRow && !scopeAdmits(recordScopeOf(principal), ownerRow.organization_id)) return 'none'
    const owner = ownerRow?.owner_user_id ?? null
    if (owner === principal.userId) return 'owner'
    // Runner access is host-wide. Resource share lists belong to the workspace service.
    // A session the host has never seen is being started right now: it is the
    // starter's, and the prompt that follows records that.
    if (owner === null && canonical.kind === 'session' && this.deps.sessionExists && !this.deps.sessionExists(canonical.id)) return 'owner'
    // A member holds what the rows give them: their own row, a team they are in,
    // or the organization. The host's own work on a managed host — automations,
    // which no person owns — is the team's to edit.
    let role: ResourceRole = 'none'
    for (const row of await this.grantRows(canonical, recordScopeOf(principal))) {
      if (rowAdmits(row, principal)) role = higherResourceRole(role, row.role)
    }
    if (role === 'none' && owner === null && principal.hostKind === 'managed') return SCOPE_ROLE
    return role
  }

  private async taskContents(scope: RecordScope, taskIds: readonly string[]): Promise<ShareResource[]> {
    if (!taskIds.length) return []
    return (await this.deps.taskContents?.(scope, taskIds) ?? []).map((item) => this.canonical(item))
  }

  /**
   * The tasks a session or work sits in. A task link may hold either the stable
   * session id or the provider thread id, so both spellings are asked for.
   */
  private async containingTasks(scope: RecordScope, resource: ShareResource, canonical: ShareResource): Promise<ContainingTask[]> {
    if (!this.deps.containingTasks || canonical.kind === 'task') return []
    const tasks = new Map<string, ContainingTask>()
    for (const spelling of sameResource(resource, canonical) ? [canonical] : [canonical, resource]) {
      for (const task of await this.deps.containingTasks(scope, spelling)) tasks.set(task.taskId, task)
    }
    return [...tasks.values()]
  }

  async assertRole(principal: Principal, resource: ShareResource, required: ResourceRole): Promise<void> {
    if (!resourceRoleAtLeast(await this.roleFor(principal, resource), required)) {
      throw new ShareAccessError('FORBIDDEN', `This ${resource.kind} is not shared with you`)
    }
  }

  /**
   * The resource ids of one kind this principal may open, or `all` for a principal
   * that is not filtered. List RPCs never return an id the caller cannot open. A
   * member's set is what they own and what a row names them on; the host's own
   * unowned work on a managed host is added by `filterVisible`, which sees the items.
   */
  async visibleIds(principal: Principal, kind: ShareResourceKind): Promise<'all' | Set<string>> {
    const scope = recordScopeOf(principal)
    if (principal.kind === 'guest') {
      const bound = this.canonical(principal.share.resource)
      if (await this.roleFor(principal, bound) === 'none') return new Set()
      const ids = new Set<string>()
      if (bound.kind === kind) ids.add(bound.id)
      if (bound.kind === 'task') for (const item of await this.taskContents(scope, [bound.id])) if (item.kind === kind) ids.add(item.id)
      return ids
    }
    if (principal.kind !== 'org-member') return 'all'
    const ids = await this.ownVisibleIds(principal, kind)
    // What a shared task holds is visible with it. One read for every such task:
    // a read per task ran two queries per owned task on each session or work list.
    if (kind !== 'task') {
      for (const item of await this.taskContents(scope, [...await this.ownVisibleIds(principal, 'task')])) {
        if (item.kind === kind) ids.add(item.id)
      }
    }
    return ids
  }

  /**
   * The ids of one kind a member owns or is named on, before any task
   * inheritance. The rows are the member's organization's: a listing store
   * already answers that organization's records only, so nothing of another
   * organization can be matched here.
   */
  private async ownVisibleIds(principal: Extract<Principal, { kind: 'org-member' }>, kind: ShareResourceKind): Promise<Set<string>> {
    const scope = recordScopeOf(principal)
    const ids = new Set<string>()
    const owned = ownerRowsSchema.parse(await this.deps.db.all(sql`
      SELECT resource_id FROM ${resourceOwner}
      WHERE ${scopeClause(scope)} AND resource_kind = ${kind} AND owner_user_id = ${principal.userId}
    `))
    for (const row of owned) ids.add(row.resource_id)
    const granted = grantRowSchema.array().parse(await this.deps.db.all(sql`
      SELECT * FROM ${shareGrant}
      WHERE ${scopeClause(scope)} AND resource_kind = ${kind} AND subject_kind <> 'everyone'
    `))
    for (const row of granted) if (rowAdmits(row, principal)) ids.add(row.resource_id)
    return ids
  }

  /** Filters a listing to what the caller may open, matching either the stable or the provider session id. */
  async filterVisible<T>(principal: Principal, kind: ShareResourceKind, items: T[], idOf: (item: T) => string): Promise<T[]> {
    const visible = await this.visibleIds(principal, kind)
    if (visible === 'all') return items
    // On a managed host, a resource nobody owns is the host's own work and the team's to see.
    // (In the cloud a runner's work is claimed for the organization as it lands, so nothing is unowned there.)
    const owned = principal.kind === 'org-member' && principal.hostKind === 'managed'
      ? new Set(ownerRowsSchema.parse(await this.deps.db.all(sql`
          SELECT resource_id FROM ${resourceOwner}
          WHERE ${scopeClause(recordScopeOf(principal))} AND resource_kind = ${kind}
        `)).map((row) => row.resource_id))
      : null
    return items.filter((item) => {
      const id = idOf(item)
      const canonicalId = this.canonical({ kind, id }).id
      if (visible.has(id) || visible.has(canonicalId)) return true
      return owned !== null && !owned.has(canonicalId)
    })
  }

  // ── The share list ──────────────────────────────────────────────────────

  async list(resourceInput: ShareResource, principal: Principal): Promise<ShareList> {
    const resource = this.canonical(resourceInput)
    const callerRole = await this.roleFor(principal, resourceInput)
    if (callerRole === 'none') throw new ShareAccessError('FORBIDDEN', `This ${resource.kind} is not shared with you`)
    return this.buildList(resource, callerRole, resourceInput)
  }

  /** A write answers with the list as it now stands, even when the writer just removed their own access. */
  private async buildList(
    resource: ShareResource,
    callerRole: ResourceRole,
    requested: ShareResource = resource,
  ): Promise<ShareList> {
    const rows = await this.grantRows(resource)
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
      ownerUserId: await this.ownerOf(resource) ?? hostUserKey(),
      grants,
      callerRole,
      link: shareLink,
    }
    // A task that is itself shared reaches this resource; the dialog says so.
    const inherited: ContainingTask[] = []
    for (const task of await this.containingTasks(ANY_ORGANIZATION, requested, resource)) {
      if ((await this.grantRows({ kind: 'task', id: task.taskId })).length > 0) inherited.push(task)
    }
    if (inherited.length) list.inheritedFrom = inherited
    return list
  }

  /** Replaces every named row. The owner and editors may share; a viewer may not (§3.4).
   *  A row removed for a team or the organization names nobody: only a person's own row does. */
  async setGrants(request: ShareSetRequest, principal: Principal): Promise<ShareList> {
    return this.deps.db.transaction(async (db) => {
      const resource = this.canonical(request.resource)
      await this.assertRole(principal, request.resource, 'editor')
      const organizationId = await this.organizationOf(resource, principal)
      const grantedBy = ownerKeyOf(actorFor(principal)) ?? hostUserKey()
      const next = new Map<string, { subject: ShareNamedSubject; role: ShareRole }>()
      for (const grant of request.grants) {
        const subject = shareNamedSubjectSchema.parse(grant.subject)
        next.set(`${subject.kind}:${subject.id}`, { subject, role: grant.role })
      }
      const removedUserIds: string[] = []
      const before = (await this.grantRows(resource, ANY_ORGANIZATION, db)).filter((row) => row.subject_kind !== 'everyone')
      for (const row of before) {
        const key = `${row.subject_kind}:${row.subject_id}`
        if (next.has(key)) continue
        await db.run(sql`
          DELETE FROM ${shareGrant}
          WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id}
            AND subject_kind = ${row.subject_kind} AND subject_id = ${row.subject_id}
        `)
        if (row.subject_kind === 'user') removedUserIds.push(row.subject_id)
      }
      for (const { subject, role } of next.values()) {
        await db.run(sql`
          INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
          VALUES (${randomUUID()}, ${resource.kind}, ${resource.id}, ${subject.kind}, ${subject.id}, ${role}, NULL, ${grantedBy}, ${this.now()}, ${organizationId})
          ON CONFLICT(resource_kind, resource_id, subject_kind, subject_id) DO UPDATE SET role = excluded.role
        `)
      }
      log.info('share_grants_set', { kind: resource.kind, resourceId: resource.id, grants: next.size, removed: removedUserIds.length })
      const sharedWithOrganization = [...next.values()].some(({ subject }) => subject.kind === 'organization'
        && !before.some((row) => row.subject_kind === 'organization' && row.subject_id === subject.id))
      await this.announce(organizationId, resource, principal, removedUserIds, false, sharedWithOrganization)
      return this.buildList(resource, await this.roleFor(principal, request.resource), request.resource)
    })
  }

  /**
   * The link: one `everyone` row. A new secret is returned here and thereafter in the
   * share list to the owner and editors. Turning the link off or regenerating it
   * disconnects every guest at once (§3.4).
   */
  async setLink(request: ShareSetLinkRequest, principal: Principal): Promise<ShareLink | null> {
    return this.deps.db.transaction(async () => {
      const resource = this.canonical(request.resource)
      await this.assertRole(principal, request.resource, 'editor')
      const organizationId = await this.organizationOf(resource, principal)
      const existing = (await this.grantRows(resource)).find((row) => row.subject_kind === 'everyone')
      const db = this.deps.db
      if (request.role === null) {
        if (!existing) return null
        await db.run(sql`
          DELETE FROM ${shareGrant}
          WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id} AND subject_kind = 'everyone'
        `)
        log.info('share_link_removed', { kind: resource.kind, resourceId: resource.id })
        await this.announce(organizationId, resource, principal, [], true)
        return null
      }
      const rotate = !existing || request.regenerate === true
      const secret = rotate ? randomBytes(32).toString('base64url') : null
      const grantedBy = ownerKeyOf(actorFor(principal)) ?? hostUserKey()
      if (secret) {
        await db.run(sql`
          INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, link_secret, granted_by_user_id, created_at, organization_id)
          VALUES (${randomUUID()}, ${resource.kind}, ${resource.id}, 'everyone', '', ${request.role}, ${hashLinkSecret(secret)}, ${secret}, ${grantedBy}, ${this.now()}, ${organizationId})
          ON CONFLICT(resource_kind, resource_id, subject_kind, subject_id) DO UPDATE SET
            role = excluded.role, link_secret_hash = excluded.link_secret_hash, link_secret = excluded.link_secret, granted_by_user_id = excluded.granted_by_user_id
        `)
      } else {
        await db.run(sql`
          UPDATE ${shareGrant} SET role = ${request.role}
          WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id} AND subject_kind = 'everyone'
        `)
      }
      log.info('share_link_set', { kind: resource.kind, resourceId: resource.id, role: request.role, rotated: rotate })
      // A regenerated secret ends the old guests; a role change alone lets them stay with the new role.
      await this.announce(organizationId, resource, principal, [], rotate && !!existing)
      if (!secret) return null
      return { role: request.role, secret }
    })
  }

  /** Admission: the secret names one resource and one role, or nothing. The hash
   *  is unique across the database, so the lookup needs no organization. */
  async resolveLinkSecret(secret: string): Promise<ResolvedLinkShare | null> {
    const hash = hashLinkSecret(secret)
    const row = grantRowSchema.nullish().parse(await this.deps.db.get(sql`
      SELECT * FROM ${shareGrant} WHERE subject_kind = 'everyone' AND link_secret_hash = ${hash}
    `))
    if (!row) return null
    return {
      organizationId: row.organization_id,
      resource: { kind: row.resource_kind, id: row.resource_id },
      role: row.role,
      sharedByUserId: row.granted_by_user_id,
      linkSecretHash: hash,
    }
  }

  /** Removes every row and the owner record when a resource is deleted. */
  async forget(resource: ShareResource): Promise<void> {
    const canonical = this.canonical(resource)
    await this.deps.db.run(sql`
      DELETE FROM ${shareGrant}
      WHERE resource_kind = ${canonical.kind} AND resource_id = ${canonical.id}
    `)
    await this.deps.db.run(sql`
      DELETE FROM ${resourceOwner}
      WHERE resource_kind = ${canonical.kind} AND resource_id = ${canonical.id}
    `)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** The rows of one resource; a member's or guest's scope keeps another organization's rows out of sight. */
  private async grantRows(resource: ShareResource, scope: RecordScope = ANY_ORGANIZATION, db: Db = this.deps.db): Promise<GrantRow[]> {
    return grantRowSchema.array().parse(await db.all(sql`
      SELECT * FROM ${shareGrant}
      WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id} AND ${scopeClause(scope)}
      ORDER BY created_at, id
    `))
  }

  private async announce(
    organizationId: string,
    resource: ShareResource,
    principal: Principal,
    removedUserIds: string[],
    guestsRevoked: boolean,
    sharedWithOrganization = false,
  ): Promise<void> {
    const actor = actorFor(principal)
    const changedBy = actor.user
    const change: ShareChange = {
      organizationId,
      resource,
      ownerUserId: await this.ownerOf(resource) ?? hostUserKey(),
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
