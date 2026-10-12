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
import { isAnyOrganization, isHostAdmin, isHostOwner, isOrganizationSpace, organizationForNew, recordScopeOf, scopeAdmits, type Principal } from '../admission/principal'
import { actorFor, ownerKeyOf, type Actor } from '../admission/actor'
import { shareGrant } from './schema'
import { hostUserKey } from '../host/host-user'
import { LOCAL_ORGANIZATION_ID } from '../admission/principal'
import { scopeClause } from '../data/scope'
import type { SharesMirrorPayload } from '../sync/runner-protocol'

const log = createLogger('main', 'share-manager')

/**
 * What a resource starts with on a managed host (decision 2026-09-16): the
 * organization, as editors. The dialog offers one choice — who can open it — with
 * a viewer-or-editor role on each level; this is the role the first level gets.
 */
const SCOPE_ROLE: ShareRole = 'editor'

/**
 * Who may open which session, work, or task
 * (docs/plans/cloud-sharing.md §4c). This file owns every row it reads:
 * one `share_grant` table holds all access. The owner is a `user` row with role
 * `owner` (at most one per resource); the other rows name a person, a team, the
 * organization, or everyone with the link. Nothing else joins this table. It
 * lives in the ported schema (`./schema.ts`), so the same code answers on a
 * host's SQLite and in the cloud's Postgres (docs/plans/cloud-service-model.md).
 *
 * Ownership is recorded here rather than on the `sessions` and `works` rows because a
 * session's index row is rewritten by the transcript indexer.
 *
 * Every row carries its resource's organization, written with the owner row
 * when the record is created. A member reaches a resource only when a row in
 * their organization names them; the owner of a personal host reaches everything
 * on the disk. Two checks ask the record itself, because no row may say: a host
 * owner whose scope is Local only, and a resource nobody owns on a managed host.
 * A resource is shared on its own: linking it to a task gives no access.
 */

const rowFields = {
  id: z.string(),
  organization_id: z.string(),
  resource_kind: z.enum(['session', 'work', 'task']),
  resource_id: z.string(),
  subject_id: z.string(),
  link_secret_hash: z.string().nullable(),
  /** The secret itself, kept so the link is always at hand; null on a row made before the column existed. */
  link_secret: z.string().nullable(),
  granted_by_user_id: z.string(),
  created_at: z.number(),
}
const grantRowSchema = z.object({ ...rowFields, subject_kind: z.enum(['user', 'team', 'organization', 'everyone']), role: shareRoleSchema })
const ownerRowSchema = z.object({ ...rowFields, subject_kind: z.literal('user'), role: z.literal('owner') })
const storedRowSchema = z.union([ownerRowSchema, grantRowSchema])
type GrantRow = z.infer<typeof grantRowSchema>
type OwnerRow = z.infer<typeof ownerRowSchema>

/** What one resource's rows say: its owner row and its other rows, of every organization. */
interface Standing {
  owner: OwnerRow | null
  grants: GrantRow[]
}

/**
 * Everything a role and a share list are computed from, read once per request.
 * A write updates it in place, so its answer needs no second read.
 */
interface ResourceAccess {
  /** The canonical resource. */
  resource: ShareResource
  /** The resource's organization: its owner row's, or the record's where a check must ask it; null when neither says. */
  organizationId: string | null
  standing: Standing
}

function linkRowOf(standing: Standing): GrantRow | undefined {
  return standing.grants.find((row) => row.subject_kind === 'everyone')
}

function byCreation(a: GrantRow, b: GrantRow): number {
  return a.created_at - b.created_at || a.id.localeCompare(b.id)
}

const resourceIdRowsSchema = z.array(z.object({ resource_id: z.string() }))

function sameResource(a: ShareResource, b: ShareResource): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** Whether a row is about this member: them, a team they are in, or their organization. */
function rowAdmits(row: GrantRow | OwnerRow, principal: Extract<Principal, { kind: 'org-member' }>): boolean {
  switch (row.subject_kind) {
    case 'user': return row.subject_id === principal.userId
    case 'team': return principal.teamIds.includes(row.subject_id)
    case 'organization': return row.subject_id === principal.organizationId
    case 'everyone': return false
  }
}

export class ShareAccessError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_SHARED' | 'HOST_NOT_LINKED', message: string) {
    super(message)
    this.name = 'ShareAccessError'
  }
}

/**
 * A task is not shared on its own (docs/plans/cloud-sharing.md §4a): its
 * organization sees it from the grant it is born with, and its link is the app's
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
   * Whether the host has any record of a session. A session nobody has recorded
   * yet is new, and the member starting it may: the access check runs before the
   * first prompt claims ownership. Without it every unowned session is closed.
   */
  sessionExists?: (sessionId: string) => boolean
  /**
   * The canonical organization of a record (organization-scope §3): the session
   * record's, the work row's, the task row's. Null when the record does not exist
   * yet — a session claimed at its first watch. Asked only where no row can say:
   * a new owner row, a Local-only host owner, and an unowned resource on a managed
   * host. Without it every resource is treated as the creating principal's.
   */
  organizationOfResource?: (resource: ShareResource) => Promise<string | null>
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

export class ShareManager {
  private readonly listeners = new Set<(change: ShareChange) => void>()

  constructor(private readonly deps: ShareManagerDeps) {}

  onChanged(listener: (change: ShareChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ── Ownership ───────────────────────────────────────────────────────────

  async ownerOf(resource: ShareResource): Promise<string | null> {
    return (await this.ownerRow(resource))?.subject_id ?? null
  }

  /** Owner metadata for a bounded page that has already passed resource visibility. */
  async ownersOf(kind: ShareResourceKind, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map()
    if (ids.length > 201) throw new Error('Owner reads require a bounded resource page.')
    const rows = ownerRowSchema.array().parse(await this.deps.db.all(sql`
      SELECT * FROM ${shareGrant}
      WHERE resource_kind = ${kind} AND resource_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) AND role = 'owner'
    `))
    return new Map(rows.map(row => [row.resource_id, row.subject_id]))
  }

  private async ownerRow(canonical: ShareResource): Promise<OwnerRow | null> {
    return ownerRowSchema.nullish().parse(await this.deps.db.get(sql`
      SELECT * FROM ${shareGrant}
      WHERE resource_kind = ${canonical.kind} AND resource_id = ${canonical.id} AND role = 'owner'
    `)) ?? null
  }

  /** The record's own organization; null when there is no record yet, or no domain to ask. */
  private async recordOrganization(canonical: ShareResource): Promise<string | null> {
    return await this.deps.organizationOfResource?.(canonical) ?? null
  }

  /** Writes the owner row unless the resource already has one; answers whether it wrote. */
  private async insertOwner(canonical: ShareResource, ownerUserId: string, organizationId: string): Promise<boolean> {
    const inserted = await this.deps.db.run(sql`
      INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
      VALUES (${randomUUID()}, ${canonical.kind}, ${canonical.id}, 'user', ${ownerUserId}, 'owner', NULL, ${ownerUserId}, ${this.now()}, ${organizationId})
      ON CONFLICT DO NOTHING
    `)
    return inserted.changes > 0
  }

  private async insertOrganizationGrant(canonical: ShareResource, organizationId: string, grantedBy: string): Promise<void> {
    await this.deps.db.run(sql`
      INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
      VALUES (${randomUUID()}, ${canonical.kind}, ${canonical.id}, 'organization', ${organizationId}, ${SCOPE_ROLE}, NULL, ${grantedBy}, ${this.now()}, ${organizationId})
      ON CONFLICT DO NOTHING
    `)
  }

  /**
   * The first principal to start a session or create a work owns it: this writes
   * the owner row, with the record's organization, when the record is created. A
   * later call for the same resource changes nothing, so every entry point may
   * claim freely.
   *
   * A resource made on a managed host or the organization's workspace service
   * starts shared with the organization: the space is the team's, so its work is
   * visible to the team until the owner narrows it. A personal host's resources
   * start private. `shareWithOrganization: false` starts one private in every
   * space: a chat, which is its owner's own (docs/projects.md, "Chats").
   */
  async claimOwner(
    resource: ShareResource,
    principal: Principal,
    options: { shareWithOrganization?: boolean } = {},
  ): Promise<string | null> {
    const ownerUserId = ownerKeyOf(actorFor(principal))
    if (!ownerUserId) return this.ownerOf(resource)
    const organizationId = await this.recordOrganization(resource) ?? organizationForNew(principal)
    const inserted = await this.insertOwner(resource, ownerUserId, organizationId)
    if (inserted && options.shareWithOrganization !== false && isOrganizationSpace(principal)) {
      await this.insertOrganizationGrant(resource, principal.organizationId, ownerUserId)
    }
    if (inserted) return scopeAdmits(recordScopeOf(principal), organizationId) ? ownerUserId : null
    // A resource another organization owns is not this caller's to see: the claim changed nothing and answers nothing.
    const row = await this.ownerRow(resource)
    if (!row || !scopeAdmits(recordScopeOf(principal), row.organization_id)) return null
    return row.subject_id
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
    const owner = await this.ownerRow(resource)
    if (owner?.subject_id !== ownerUserId) return
    await this.insertOrganizationGrant(resource, principal.organizationId, ownerUserId)
  }

  /**
   * A resource a runner's op wrote into the organization's workspace
   * (cloud-service-model.md §16): owned by the person whose delegated token
   * delivered it (a runner always acts for one), and shared with the
   * organization as editors like anything made in the organization's space, unless
   * it is a chat (plan 004 D14). A resource that already has an owner is left as it is.
   */
  async claimForRunner(resource: ShareResource, runner: Extract<Principal, { kind: 'runner' }>, options: { shareWithOrganization: boolean } = { shareWithOrganization: true }): Promise<void> {
    const inserted = await this.insertOwner(resource, runner.ownerUserId, runner.organizationId)
    if (inserted && options.shareWithOrganization) await this.insertOrganizationGrant(resource, runner.organizationId, runner.ownerUserId)
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
    await this.deps.db.transaction(async (db) => {
      const owner = await this.ownerRow(resource)
      if (owner && owner.organization_id !== LOCAL_ORGANIZATION_ID && owner.organization_id !== organizationId) return
      // The new owner's own named row would duplicate the owner row.
      await db.run(sql`
        DELETE FROM ${shareGrant}
        WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id} AND subject_kind = 'user' AND subject_id = ${ownerUserId} AND role <> 'owner'
      `)
      if (owner) {
        await db.run(sql`UPDATE ${shareGrant} SET subject_id = ${ownerUserId}, granted_by_user_id = ${ownerUserId}, organization_id = ${organizationId} WHERE id = ${owner.id}`)
      } else {
        await this.insertOwner(resource, ownerUserId, organizationId)
      }
      if (options.shareWithOrganization) await this.insertOrganizationGrant(resource, organizationId, ownerUserId)
    })
  }

  /**
   * The owner may hand a resource to another member. A host admin may also hand on
   * what a member who left the organization owned (plan 004 item 10). The change is
   * announced to everyone with access.
   */
  async transfer(request: ShareTransferRequest, principal: Principal): Promise<ShareList> {
    return this.deps.db.transaction(async (db) => {
      const access = await this.access(principal, request.resource)
      const { resource, standing } = access
      const organizationId = await this.writeOrganization(access, principal)
      const previousOwner = standing.owner?.subject_id ?? null
      if (this.roleIn(principal, access) !== 'owner' && !this.mayTransferForDeparted(principal, access, organizationId, previousOwner)) {
        throw new ShareAccessError('FORBIDDEN', 'Only the owner can transfer ownership')
      }
      // The new owner's named row, if any, gives way to the owner row.
      const named = standing.grants.find((row) => row.subject_kind === 'user' && row.subject_id === request.toUserId)
      if (named) {
        await db.run(sql`DELETE FROM ${shareGrant} WHERE id = ${named.id}`)
        standing.grants = standing.grants.filter((row) => row !== named)
      }
      if (standing.owner) {
        await db.run(sql`UPDATE ${shareGrant} SET subject_id = ${request.toUserId} WHERE id = ${standing.owner.id}`)
        standing.owner = { ...standing.owner, subject_id: request.toUserId }
      } else {
        await this.insertOwner(resource, request.toUserId, organizationId)
        standing.owner = await this.ownerRow(resource)
      }
      log.info('share_ownership_transferred', { kind: resource.kind, resourceId: resource.id, toUserId: request.toUserId })
      await this.announce(organizationId, access, principal, previousOwner && previousOwner !== request.toUserId ? [previousOwner] : [], false)
      return this.listOf(access, this.roleIn(principal, access))
    })
  }

  /** A host admin, in the resource's organization, whose owner has left it. */
  private mayTransferForDeparted(principal: Principal, access: ResourceAccess, organizationId: string, owner: string | null): boolean {
    if (!owner || !isHostAdmin(principal) || !this.deps.hasLeftOrganization) return false
    const scope = recordScopeOf(principal)
    if (!scopeAdmits(scope, organizationId) || (access.organizationId !== null && !scopeAdmits(scope, access.organizationId))) return false
    return this.deps.hasLeftOrganization(organizationId, owner)
  }

  // ── Roles ───────────────────────────────────────────────────────────────

  /** The highest role this principal holds on the resource (§3.4, §3.5). */
  async roleFor(principal: Principal, resource: ShareResource): Promise<ResourceRole> {
    if (principal.kind === 'system') return 'owner'
    // A runner holds no role on anything; its writes go through the system-only methods.
    if (principal.kind === 'runner') return 'none'
    // The host's owner holds every role on the whole disk, and reads nothing to know it.
    if (isHostOwner(principal) && isAnyOrganization(recordScopeOf(principal))) return 'owner'
    return this.roleIn(principal, await this.access(principal, resource))
  }

  /**
   * The resource's rows, in one read, and its organization. The organization is
   * the owner row's; only the two checks no row can answer ask the record.
   */
  private async access(principal: Principal, resource: ShareResource): Promise<ResourceAccess> {
    const standing = await this.standing(resource)
    // A Local-only host owner must not open an organization record through a
    // stale or missing row: a fork or an Insights assignment moves a session into
    // an organization without rewriting its rows.
    const localOnlyOwner = isHostOwner(principal) && !isAnyOrganization(recordScopeOf(principal))
    // A resource nobody owns is the team's on a managed host, but only in its own organization.
    const unownedOnManaged = principal.kind === 'org-member' && principal.hostKind === 'managed' && !standing.owner
    const organizationId = localOnlyOwner || unownedOnManaged
      ? await this.recordOrganization(resource)
      : standing.owner?.organization_id ?? null
    return { resource, organizationId, standing }
  }

  /** The organization a write's new rows carry: the resource's, else the record's, else the writer's. */
  private async writeOrganization(access: ResourceAccess, principal: Principal): Promise<string> {
    return access.organizationId ?? await this.recordOrganization(access.resource) ?? organizationForNew(principal)
  }

  /** The role `access` gives this principal; it reads nothing, so a write can ask again after it changes `access`. */
  private roleIn(principal: Principal, access: ResourceAccess): ResourceRole {
    if (principal.kind === 'system') return 'owner'
    const scope = recordScopeOf(principal)
    const admitted = access.organizationId === null || scopeAdmits(scope, access.organizationId)
    // The host's owner holds every role on what their scope reaches: the whole disk,
    // or only its Local records for a pairing connection to an attached machine.
    if (isHostOwner(principal)) return admitted ? 'owner' : 'none'
    if (principal.kind === 'runner') return 'none'
    // A record of another organization is not this member's to see, whatever the rows say (§3).
    if (!admitted) return 'none'
    if (principal.kind === 'guest') {
      const bound = principal.share.resource
      if (bound.kind === 'task' || !sameResource(bound, access.resource)) return 'none'
      // The link the guest arrived with must still exist unchanged, in the guest's organization.
      const row = linkRowOf(access.standing)
      if (!row || !scopeAdmits(scope, row.organization_id) || row.link_secret_hash !== principal.share.linkSecretHash) return 'none'
      return row.role
    }
    return this.memberRole(principal, access)
  }

  /** A member's role from the rows: the owner row, their own row, a team they are in, or the organization. */
  private memberRole(principal: Extract<Principal, { kind: 'org-member' }>, access: ResourceAccess): ResourceRole {
    const scope = recordScopeOf(principal)
    const { owner, grants } = access.standing
    if (owner?.subject_id === principal.userId) return 'owner'
    // A session the host has never seen is being started right now: it is the
    // starter's, and the prompt that follows records that.
    const resource = access.resource
    if (!owner && resource.kind === 'session' && this.deps.sessionExists && !this.deps.sessionExists(resource.id)) return 'owner'
    // The host's own work on a managed host — automations, which no person
    // owns — is the team's to edit.
    let role: ResourceRole = 'none'
    for (const row of grants) {
      if (scopeAdmits(scope, row.organization_id) && rowAdmits(row, principal)) role = higherResourceRole(role, row.role)
    }
    if (role === 'none' && !owner && principal.hostKind === 'managed') return SCOPE_ROLE
    return role
  }

  async assertRole(principal: Principal, resource: ShareResource, required: ResourceRole): Promise<void> {
    if (!resourceRoleAtLeast(await this.roleFor(principal, resource), required)) {
      throw new ShareAccessError('FORBIDDEN', `This ${resource.kind} is not shared with you`)
    }
  }

  /**
   * The resource ids of one kind this principal may open, or `all` for a principal
   * that is not filtered. List RPCs never return an id the caller cannot open. A
   * member's set is what a row names them on, the owner row included; the host's
   * own unowned work on a managed host is added by `filterVisible`, which sees the
   * items. The rows are the member's organization's: a listing store already
   * answers that organization's records only.
   */
  async visibleIds(principal: Principal, kind: ShareResourceKind): Promise<'all' | Set<string>> {
    if (principal.kind === 'guest') {
      const bound = principal.share.resource
      if (await this.roleFor(principal, bound) === 'none') return new Set()
      return new Set(bound.kind === kind ? [bound.id] : [])
    }
    if (principal.kind !== 'org-member') return 'all'
    const rows = storedRowSchema.array().parse(await this.deps.db.all(sql`
      SELECT * FROM ${shareGrant}
      WHERE ${scopeClause(recordScopeOf(principal))} AND resource_kind = ${kind} AND subject_kind <> 'everyone'
    `))
    return new Set(rows.filter((row) => rowAdmits(row, principal)).map((row) => row.resource_id))
  }

  /** Filters a listing to what the caller may open, matching either the stable or the provider session id. */
  async filterVisible<T>(principal: Principal, kind: ShareResourceKind, items: T[], idOf: (item: T) => string): Promise<T[]> {
    const visible = await this.visibleIds(principal, kind)
    if (visible === 'all') return items
    // On a managed host, a resource nobody owns is the host's own work and the team's to see.
    // (In the cloud a runner's work is claimed for the organization as it lands, so nothing is unowned there.)
    const owned = principal.kind === 'org-member' && principal.hostKind === 'managed'
      ? new Set(resourceIdRowsSchema.parse(await this.deps.db.all(sql`
          SELECT resource_id FROM ${shareGrant}
          WHERE ${scopeClause(recordScopeOf(principal))} AND resource_kind = ${kind} AND role = 'owner'
        `)).map((row) => row.resource_id))
      : null
    return items.filter((item) => {
      const id = idOf(item)
      if (visible.has(id)) return true
      return owned !== null && !owned.has(id)
    })
  }

  // ── The share list ──────────────────────────────────────────────────────

  async list(resourceInput: ShareResource, principal: Principal): Promise<ShareList> {
    const access = await this.access(principal, resourceInput)
    const callerRole = this.roleIn(principal, access)
    if (callerRole === 'none') throw new ShareAccessError('FORBIDDEN', `This ${access.resource.kind} is not shared with you`)
    return this.listOf(access, callerRole)
  }

  /** The list `access` describes. A write answers with it as it now stands, even when the writer just removed their own access. */
  private listOf(access: ResourceAccess, callerRole: ResourceRole): ShareList {
    const link = linkRowOf(access.standing)
    const grants: ShareGrant[] = access.standing.grants
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
      ownerUserId: access.standing.owner?.subject_id ?? hostUserKey(),
      grants,
      callerRole,
      link: shareLink,
    }
  }

  /**
   * Replaces every named row, and the link too when the request names it, in one
   * transaction: a scope change is one call, and the list never lands between two
   * scopes. The owner and editors may share; a viewer may not (§3.4). A row
   * removed for a team or the organization names nobody: only a person's own row
   * does. The owner keeps the owner row; a named row for them is ignored.
   */
  async setGrants(request: ShareSetRequest, principal: Principal): Promise<ShareList> {
    assertShareable(request.resource)
    if (request.grants.length > 0 && this.deps.membersReachable?.() === false) throw new ShareAccessError('HOST_NOT_LINKED', MEMBERS_CANNOT_REACH)
    await this.joinNamedOrganization(request, principal)
    return this.deps.db.transaction(async (db) => {
      const access = await this.access(principal, request.resource)
      this.assertEditor(principal, access)
      const { resource, standing } = access
      const organizationId = await this.writeOrganization(access, principal)
      const grantedBy = ownerKeyOf(actorFor(principal)) ?? hostUserKey()
      const next = new Map<string, { subject: ShareNamedSubject; role: ShareRole }>()
      for (const grant of request.grants) {
        const subject = shareNamedSubjectSchema.parse(grant.subject)
        if (subject.kind === 'user' && subject.id === standing.owner?.subject_id) continue
        next.set(`${subject.kind}:${subject.id}`, { subject, role: grant.role })
      }
      const before = new Map(standing.grants.filter((row) => row.subject_kind !== 'everyone').map((row) => [`${row.subject_kind}:${row.subject_id}`, row]))
      const removed = [...before.entries()].filter(([key]) => !next.has(key)).map(([, row]) => row)
      if (removed.length) {
        await db.run(sql`DELETE FROM ${shareGrant} WHERE id IN (${sql.join(removed.map((row) => sql`${row.id}`), sql`, `)})`)
      }
      const now = this.now()
      const kept: GrantRow[] = []
      const added: GrantRow[] = []
      for (const [key, { subject, role }] of next) {
        const existing = before.get(key)
        if (!existing) {
          added.push({ id: randomUUID(), organization_id: organizationId, resource_kind: resource.kind, resource_id: resource.id, subject_kind: subject.kind, subject_id: subject.id, role, link_secret_hash: null, link_secret: null, granted_by_user_id: grantedBy, created_at: now })
          continue
        }
        if (existing.role !== role) await db.run(sql`UPDATE ${shareGrant} SET role = ${role} WHERE id = ${existing.id}`)
        kept.push({ ...existing, role })
      }
      if (added.length) {
        await db.run(sql`
          INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
          VALUES ${sql.join(added.map((row) => sql`(${row.id}, ${row.resource_kind}, ${row.resource_id}, ${row.subject_kind}, ${row.subject_id}, ${row.role}, NULL, ${row.granted_by_user_id}, ${row.created_at}, ${row.organization_id})`), sql`, `)}
        `)
      }
      const linkRow = linkRowOf(standing)
      standing.grants = [...kept, ...added, ...(linkRow ? [linkRow] : [])].sort(byCreation)
      const removedUserIds = removed.filter((row) => row.subject_kind === 'user').map((row) => row.subject_id)
      log.info('share_grants_set', { kind: resource.kind, resourceId: resource.id, grants: next.size, removed: removedUserIds.length })
      const link = request.link ? await this.writeLink(access, request.link.role, false, organizationId, grantedBy) : null
      const sharedWithOrganization = [...next.values()].some(({ subject }) => subject.kind === 'organization' && !before.has(`organization:${subject.id}`))
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
    const named = request.grants.find((grant) => grant.subject.kind === 'organization')?.subject.id
    if (!named) return
    const access = await this.access(principal, request.resource)
    this.assertEditor(principal, access)
    const current = access.organizationId ?? await this.recordOrganization(access.resource)
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
   * its share rows written while it was Local move with it, so the owner row and
   * every grant name the record's one organization. Rows of any other
   * organization are never touched.
   */
  async followRecordOrganization(resource: ShareResource, organizationId: string): Promise<void> {
    if (organizationId === LOCAL_ORGANIZATION_ID) return
    const moved = await this.deps.db.run(sql`
      UPDATE ${shareGrant} SET organization_id = ${organizationId}
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
      const access = await this.access(principal, request.resource)
      this.assertEditor(principal, access)
      const organizationId = await this.writeOrganization(access, principal)
      const grantedBy = ownerKeyOf(actorFor(principal)) ?? hostUserKey()
      const change = await this.writeLink(access, request.role, request.regenerate === true, organizationId, grantedBy)
      if (change.changed) await this.announce(organizationId, access, principal, [], change.guestsRevoked)
      return change.link
    })
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
    const { resource, standing } = access
    const existing = linkRowOf(standing)
    const db = this.deps.db
    if (role === null) {
      if (!existing) return { changed: false, guestsRevoked: false, link: null }
      await db.run(sql`DELETE FROM ${shareGrant} WHERE id = ${existing.id}`)
      standing.grants = standing.grants.filter((row) => row !== existing)
      log.info('share_link_removed', { kind: resource.kind, resourceId: resource.id })
      return { changed: true, guestsRevoked: true, link: null }
    }
    if (existing && !regenerate) {
      const changed = existing.role !== role
      if (changed) await db.run(sql`UPDATE ${shareGrant} SET role = ${role} WHERE id = ${existing.id}`)
      existing.role = role
      log.info('share_link_set', { kind: resource.kind, resourceId: resource.id, role, rotated: false })
      return { changed, guestsRevoked: false, link: existing.link_secret ? { role, secret: existing.link_secret } : null }
    }
    const secret = randomBytes(32).toString('base64url')
    const row: GrantRow = existing
      ? { ...existing, role, link_secret_hash: hashLinkSecret(secret), link_secret: secret, granted_by_user_id: grantedBy }
      : { id: randomUUID(), organization_id: organizationId, resource_kind: resource.kind, resource_id: resource.id, subject_kind: 'everyone', subject_id: '', role, link_secret_hash: hashLinkSecret(secret), link_secret: secret, granted_by_user_id: grantedBy, created_at: this.now() }
    await db.run(existing
      ? sql`UPDATE ${shareGrant} SET role = ${role}, link_secret_hash = ${row.link_secret_hash}, link_secret = ${secret}, granted_by_user_id = ${grantedBy} WHERE id = ${existing.id}`
      : sql`
        INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, link_secret, granted_by_user_id, created_at, organization_id)
        VALUES (${row.id}, ${row.resource_kind}, ${row.resource_id}, 'everyone', '', ${role}, ${row.link_secret_hash}, ${secret}, ${grantedBy}, ${row.created_at}, ${row.organization_id})
      `)
    standing.grants = [...standing.grants.filter((grant) => grant !== existing), row].sort(byCreation)
    log.info('share_link_set', { kind: resource.kind, resourceId: resource.id, role, rotated: true })
    // A regenerated secret ends the old guests.
    return { changed: true, guestsRevoked: !!existing, link: { role, secret } }
  }

  /** Admission: the secret names one resource and one role, or nothing. The hash
   *  is unique across the database, so the lookup needs no organization. */
  async resolveLinkSecret(secret: string): Promise<ResolvedLinkShare | null> {
    const hash = hashLinkSecret(secret)
    const row = grantRowSchema.nullish().parse(await this.deps.db.get(sql`
      SELECT * FROM ${shareGrant} WHERE subject_kind = 'everyone' AND link_secret_hash = ${hash}
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
   * The resource's rows but the owner's, as the host that runs it sends them up.
   * The link goes as its hash: the API admits a guest with it and never copies the
   * secret itself.
   */
  async mirroredRows(resource: ShareResource): Promise<SharesMirrorPayload['rows']> {
    const standing = await this.standing(resource)
    return standing.grants.map((row) => ({
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      role: row.role,
      linkSecretHash: row.link_secret_hash,
      grantedByUserId: row.granted_by_user_id,
      createdAt: row.created_at,
    }))
  }

  /**
   * The mirror's sink on the Solus API: the host's rows replace every row but the
   * owner's, in the resource's organization. A link whose hash changed or went ends
   * the guests it admitted here, as a change made here would.
   */
  async applyMirroredRows(organizationId: string, payload: SharesMirrorPayload): Promise<void> {
    const { resource, rows } = payload
    await this.deps.db.transaction(async (db) => {
      const before = linkRowOf(await this.standing(resource))
      await db.run(sql`
        DELETE FROM ${shareGrant}
        WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id} AND organization_id = ${organizationId} AND role <> 'owner'
      `)
      for (const row of rows) {
        await db.run(sql`
          INSERT INTO ${shareGrant} (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, link_secret, granted_by_user_id, created_at, organization_id)
          VALUES (${randomUUID()}, ${resource.kind}, ${resource.id}, ${row.subjectKind}, ${row.subjectId}, ${row.role}, ${row.linkSecretHash}, NULL, ${row.grantedByUserId}, ${row.createdAt}, ${organizationId})
          ON CONFLICT DO NOTHING
        `)
      }
      const after = rows.find((row) => row.subjectKind === 'everyone')
      const guestsRevoked = !!before && (!after || after.linkSecretHash !== before.link_secret_hash)
      const standing = await this.standing(resource)
      const change: ShareChange = { organizationId, resource, ownerUserId: standing.owner?.subject_id ?? hostUserKey(), removedUserIds: [], guestsRevoked }
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

  /** Removes every row, the owner row included, when a resource is deleted. */
  async forget(resource: ShareResource): Promise<void> {
    await this.deps.db.run(sql`
      DELETE FROM ${shareGrant}
      WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id}
    `)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Every row of one resource, of every organization, in one read: checks filter them by scope in memory. */
  private async standing(resource: ShareResource): Promise<Standing> {
    const rows = storedRowSchema.array().parse(await this.deps.db.all(sql`
      SELECT * FROM ${shareGrant}
      WHERE resource_kind = ${resource.kind} AND resource_id = ${resource.id}
      ORDER BY created_at, id
    `))
    const standing: Standing = { owner: null, grants: [] }
    for (const row of rows) {
      if (row.role === 'owner') standing.owner = row
      else standing.grants.push(row)
    }
    return standing
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
      ownerUserId: access.standing.owner?.subject_id ?? hostUserKey(),
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
