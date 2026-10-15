import { sql, type SQL } from 'drizzle-orm'
import { higherResourceRole, shareResourceKindSchema, type ResourceRole, type ShareResourceKind, type ShareRole } from '@solus/contracts/sharing'
import type { ResourceKind } from '@solus/contracts/permissions'
import { ownerKeyOf, type Actor } from './actor'
import { isAnyOrganization, isHostAdmin, recordScopeOf, scopeAdmits, type RecordScope } from './principal'
import { aclEntry } from '../sharing/schema'

/**
 * One function decides a resource role (docs/plans/access-model.md §2.3).
 * `roleOf` answers for one loaded resource; `visibleTo` is the same rule as
 * one SQL predicate, so a list and a get cannot disagree. Nothing else decides
 * who may read or change a resource.
 */


/** A resource a call names: its kind and id. */
export interface AccessResource {
  kind: ResourceKind
  id: string
}

/** A resource only its owner can reach: no administrator and no ACL entry reaches it. */
const PERSONAL: ReadonlySet<ResourceKind> = new Set(['integration', 'notification', 'browserProfile'])

/**
 * Whether a kind can have ACL entries: only what an owner can share. Every other
 * kind has none, so its predicate does not read `acl_entry`, which is not in the
 * database of an automation (the host's own SQLite file) or an insight
 * (`metrics.db`).
 */
function isShareable(kind: ResourceKind): kind is ShareResourceKind {
  return shareResourceKindSchema.safeParse(kind).success
}

/** One ACL entry: what the owner gave to someone else. */
export interface AclEntry {
  subjectKind: 'user' | 'team' | 'organization' | 'everyone'
  subjectId: string
  role: ShareRole
  /** The entry's organization; it counts only inside the actor's scope. */
  organizationId: string
  /** Set on the `everyone` entry: the hash of the link's secret. */
  linkSecretHash: string | null
}

/** What `roleOf` reads of a resource: its own row and its ACL entries. */
export interface ResourceRow {
  kind: ResourceKind
  id: string
  organizationId: string
  ownerKey: string
  acl: readonly AclEntry[]
}

/** Whether an ACL entry names this actor: the person, a team they are in, their organization, or the link they arrived with. */
function entryNames(actor: Actor, resource: Pick<ResourceRow, 'kind' | 'id'>, entry: AclEntry): boolean {
  const principal = actor.principal
  switch (entry.subjectKind) {
    case 'user': return entry.subjectId === ownerKeyOf(actor)
    case 'team': return principal.kind === 'org-member' && principal.teamIds.includes(entry.subjectId)
    case 'organization': return principal.kind === 'org-member' && entry.subjectId === principal.organizationId
    case 'everyone': {
      if (principal.kind !== 'guest') return false
      const bound = principal.share.resource
      // A guest reaches only the resource its link was made for, while that link is unchanged.
      return bound.kind !== 'task' && bound.kind === resource.kind && bound.id === resource.id && entry.linkSecretHash === principal.share.linkSecretHash
    }
  }
}

/**
 * The role `actor` holds on `resource`. The host itself (`system`) holds every
 * role; a runner holds none: its writes go through the system-only methods.
 */
export function roleOf(actor: Actor, resource: ResourceRow): ResourceRole {
  const principal = actor.principal
  if (principal.kind === 'system') return 'owner'
  if (principal.kind === 'runner') return 'none'
  const scope = recordScopeOf(principal)
  if (!scopeAdmits(scope, resource.organizationId)) return 'none'
  if (resource.ownerKey === ownerKeyOf(actor)) return 'owner'
  if (PERSONAL.has(resource.kind)) return 'none'
  let role: ResourceRole = isHostAdmin(principal) ? 'editor' : 'none'
  for (const entry of resource.acl) {
    if (scopeAdmits(scope, entry.organizationId) && entryNames(actor, resource, entry)) role = higherResourceRole(role, entry.role)
  }
  return role
}

/** The columns of the resource table a predicate reads. */
export interface ResourceColumns {
  id: SQL
  organization: SQL
  owner: SQL
}

function inScope(scope: RecordScope, column: SQL): SQL {
  return isAnyOrganization(scope) ? sql`1 = 1` : sql`${column} = ${scope}`
}

/** The ACL entries that name this actor, as one OR of subject tests on the alias `acl`. */
function namingClause(actor: Actor, kind: ResourceKind, id: SQL): SQL {
  const principal = actor.principal
  const person = ownerKeyOf(actor)
  const clauses: SQL[] = []
  if (person !== null) clauses.push(sql`(acl.subject_kind = 'user' AND acl.subject_id = ${person})`)
  if (principal.kind === 'org-member') {
    if (principal.teamIds.length) clauses.push(sql`(acl.subject_kind = 'team' AND acl.subject_id IN (${sql.join(principal.teamIds.map((teamId) => sql`${teamId}`), sql`, `)}))`)
    clauses.push(sql`(acl.subject_kind = 'organization' AND acl.subject_id = ${principal.organizationId})`)
  }
  if (principal.kind === 'guest') {
    const bound = principal.share.resource
    if (bound.kind !== 'task' && bound.kind === kind) {
      clauses.push(sql`(acl.subject_kind = 'everyone' AND acl.link_secret_hash = ${principal.share.linkSecretHash} AND ${id} = ${bound.id})`)
    }
  }
  return clauses.length ? sql`(${sql.join(clauses, sql` OR `)})` : sql`1 = 0`
}

/**
 * `roleOf(actor, row) !== 'none'` as a predicate on the resource table's
 * columns, for list queries. Apply it before LIMIT.
 */
export function visibleTo(actor: Actor, kind: ResourceKind, columns: ResourceColumns): SQL {
  const principal = actor.principal
  if (principal.kind === 'system') return sql`1 = 1`
  if (principal.kind === 'runner') return sql`1 = 0`
  const scope = recordScopeOf(principal)
  const person = ownerKeyOf(actor)
  const owned = person === null ? sql`1 = 0` : sql`${columns.owner} = ${person}`
  if (PERSONAL.has(kind)) return sql`(${inScope(scope, columns.organization)} AND ${owned})`
  if (isHostAdmin(principal)) return inScope(scope, columns.organization)
  if (!isShareable(kind)) return sql`(${inScope(scope, columns.organization)} AND ${owned})`
  const named = sql`EXISTS (SELECT 1 FROM ${aclEntry} AS acl
    WHERE acl.resource_kind = ${kind} AND acl.resource_id = ${columns.id}
      AND ${inScope(scope, sql`acl.organization_id`)} AND ${namingClause(actor, kind, columns.id)})`
  return sql`(${inScope(scope, columns.organization)} AND (${owned} OR ${named}))`
}
