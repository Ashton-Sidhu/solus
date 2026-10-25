import { sql, type SQL } from 'drizzle-orm'
import { higherResourceRole, shareResourceKindSchema, type ResourceRole, type ShareResourceKind, type ShareRole } from '@solus/contracts/sharing'
import type { ResourceKind, ResourceStanding, SessionActionLeaf } from '@solus/contracts/permissions'
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
  /** The leaves a `custom` entry holds; null for a preset. */
  actions: readonly SessionActionLeaf[] | null
  /** When the entry stops naming anyone, on this host's clock; null never. */
  expiresAt: number | null
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
function entryNames(actor: Actor, resource: Pick<ResourceRow, 'kind' | 'id'>, entry: AclEntry, now: number): boolean {
  const principal = actor.principal
  if (entry.expiresAt !== null && entry.expiresAt <= now) return false
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
 * The standing `actor` holds on `resource`: the highest preset role its entries
 * give, and the leaves its custom entries list (docs/plans/custom-roles.md §6).
 * The host itself (`system`) is the owner; a runner holds nothing: its writes go
 * through the system-only methods.
 */
export function standingOf(actor: Actor, resource: ResourceRow, now = Date.now()): ResourceStanding {
  const principal = actor.principal
  if (principal.kind === 'system') return { role: 'owner' }
  if (principal.kind === 'runner') return { role: 'none' }
  const scope = recordScopeOf(principal)
  if (!scopeAdmits(scope, resource.organizationId)) return { role: 'none' }
  if (resource.ownerKey === ownerKeyOf(actor)) return { role: 'owner' }
  if (PERSONAL.has(resource.kind)) return { role: 'none' }
  let role: ResourceRole = isHostAdmin(principal) ? 'editor' : 'none'
  const actions = new Set<SessionActionLeaf>()
  for (const entry of resource.acl) {
    if (!scopeAdmits(scope, entry.organizationId) || !entryNames(actor, resource, entry, now)) continue
    role = higherResourceRole(role, entry.role)
    for (const action of entry.actions ?? []) actions.add(action)
  }
  return actions.size ? { role, actions: [...actions] } : { role }
}

/** The role alone, for the questions that ask only "how far": may share, may own, may open. */
export function roleOf(actor: Actor, resource: ResourceRow, now = Date.now()): ResourceRole {
  return standingOf(actor, resource, now).role
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
function namingClause(actor: Actor, kind: ResourceKind, id: SQL, now: number): SQL {
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
      clauses.push(sql`(acl.subject_kind = 'everyone' AND acl.link_secret_hash = ${principal.share.linkSecretHash} AND ${id} = ${bound.id}
        AND (acl.expires_at IS NULL OR acl.expires_at > ${now}))`)
    }
  }
  return clauses.length ? sql`(${sql.join(clauses, sql` OR `)})` : sql`1 = 0`
}

/**
 * `roleOf(actor, row) !== 'none'` as a predicate on the resource table's
 * columns, for list queries. Apply it before LIMIT.
 */
export function visibleTo(actor: Actor, kind: ResourceKind, columns: ResourceColumns, now = Date.now()): SQL {
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
      AND ${inScope(scope, sql`acl.organization_id`)} AND ${namingClause(actor, kind, columns.id, now)})`
  return sql`(${inScope(scope, columns.organization)} AND (${owned} OR ${named}))`
}
