import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { userKey, type Attribution } from '@solus/contracts/user'
import type { Db } from '../../db/database'
import { hostUserKey } from '../../host/host-user'
import { session } from '../sessions/schema'
import { works } from '../works/schema'
import { resourceLinks } from './schema'

/**
 * The edge table's shared vocabulary and the rules every writer of it keeps
 * (plans/029-fresh-database-baseline.md §5.1). The stores of each relationship
 * (`tasks/task-links.ts`, `tasks/task-sessions.ts`, `sessions/session-links.ts`,
 * `sessions/session-pull-requests.ts`, `sessions/pull-request-watches.ts`, and
 * `works/work.ts` for membership) write their own rows; this module is what they
 * agree on, not a second store.
 */

export type LinkSourceKind = 'task' | 'session'
export type LinkTargetKind = 'work' | 'plan' | 'pr' | 'automation' | 'session' | 'file'
export type LinkRelation = 'works-on' | 'reference' | 'output' | 'member' | 'pull-request'
/** Who or what made an edge: a person, an agent, Solus itself; a pull request also by its branch or its creation. */
export type LinkProvenance = 'manual' | 'agent' | 'system' | 'branch' | 'created'
export type LinkStatus = 'active' | 'dismissed' | 'historical'

export const linkRelationSchema = z.enum(['works-on', 'reference', 'output', 'member', 'pull-request'])
export const linkProvenanceSchema = z.enum(['manual', 'agent', 'system', 'branch', 'created'])
export const linkStatusSchema = z.enum(['active', 'dismissed', 'historical'])
export const pullRequestStateSchema = z.enum(['open', 'closed', 'merged', 'missing'])
export type PullRequestState = z.infer<typeof pullRequestStateSchema>

/** The identity of one edge: the unique index `resource_links_edge`. */
export interface LinkEdge {
  sourceKind: LinkSourceKind
  sourceId: string
  targetKind: LinkTargetKind
  targetScope: string
  targetKey: string
}

export function edgeClause(edge: LinkEdge): SQL {
  return sql`resource_links.source_kind = ${edge.sourceKind} AND resource_links.source_id = ${edge.sourceId}
    AND resource_links.target_kind = ${edge.targetKind} AND resource_links.target_scope = ${edge.targetScope}
    AND resource_links.target_key = ${edge.targetKey}`
}

export function sourceClause(kind: LinkSourceKind, id: string): SQL {
  return sql`resource_links.source_kind = ${kind} AND resource_links.source_id = ${id}`
}

/** A session target has one spelling: an empty scope. A repository is lower case. */
export function canonicalTargetScope(targetKind: LinkTargetKind, targetScope: string): string {
  if (targetKind === 'session') return ''
  if (targetKind === 'pr') return targetScope.trim().toLowerCase()
  return targetScope
}

/** The provenance an attribution implies: a person is `manual`, an agent `agent`, anything else Solus itself. */
export function provenanceOf(by: Attribution): LinkProvenance {
  if (by.kind === 'user') return 'manual'
  if (by.kind === 'agent') return 'agent'
  return 'system'
}

/** The person an attribution names, as a user id; null when it names none. */
export function userIdOf(by: Attribution): string | null {
  if (by.kind === 'user') return userKey(by.user.id)
  if ((by.kind === 'agent' || by.kind === 'automation') && by.for) return userKey(by.for.id)
  return null
}

/**
 * `created_by` of a new edge: the person the writer acts for, else the owner of
 * the record the edge starts from, else the host's user. Never a client value.
 */
export async function creatorOf(by: Attribution, sourceOwner: () => Promise<string | null>): Promise<string> {
  return userIdOf(by) ?? await sourceOwner() ?? hostUserKey()
}

const ownerRowSchema = z.object({ created_by: z.string() })

/** The owner of a session's row, started or not, or null when no row names it. */
export async function sessionOwner(db: Db, sessionId: string): Promise<string | null> {
  const row = ownerRowSchema.nullish().parse(await db.get(sql`SELECT created_by FROM ${session} WHERE session_id = ${sessionId}`))
  return row?.created_by ?? null
}

/**
 * The canonical pull request an edge names, from its URL when it has one, else
 * from a scope that is a repository key. A checkout path is an unresolved
 * alias: it keeps its raw identity and gets its canonical one from PR sync.
 */
export function canonicalPullRequest(url: string | null | undefined, targetScope: string, targetKey: string): { repository: string; number: number } | null {
  const number = Number(targetKey)
  if (!Number.isSafeInteger(number) || number <= 0) return null
  const parsed = url ? parseGitHubPullRequestUrl(url) : null
  if (parsed && parsed.number === number) {
    const { host, owner, repo } = parsed.baseRepo
    return { repository: `${host}/${owner}/${repo}`.toLowerCase(), number }
  }
  const scope = targetScope.trim().toLowerCase()
  if (!scope || scope.startsWith('/') || scope.startsWith('\\') || /^[a-z]:[\\/]/.test(scope)) return null
  return { repository: scope, number }
}

/**
 * Every edge of a deleted record, in the deleting transaction: the endpoints
 * are polymorphic, so no foreign key does this. A session takes its plans'
 * edges with it, since a plan is the session's.
 */
export async function deleteEdgesOf(db: Db, kind: 'task' | 'work' | 'session', id: string): Promise<void> {
  const target = sql`(resource_links.target_kind = ${kind} AND resource_links.target_key = ${id})`
  const clause = kind === 'work'
    ? target
    : kind === 'task'
      ? sql`${sourceClause('task', id)} OR ${target}`
      : sql`${sourceClause('session', id)} OR ${target} OR (resource_links.target_kind = 'plan' AND resource_links.target_scope = ${id})`
  await db.run(sql`DELETE FROM ${resourceLinks} WHERE ${clause}`)
}

/**
 * Edges whose work or session endpoint no longer exists: what every delete
 * path must leave at zero. Tests assert it; a pull request, a file, or an
 * automation is not a record of this database and is not counted. Nor is a
 * task: GitHub or Jira owns it, and an edge needs no copy of it on this host.
 */
export async function danglingEdgeCount(db: Db): Promise<number> {
  const row = z.object({ n: z.coerce.number() }).parse(await db.get(sql`
    SELECT COUNT(*) AS n FROM ${resourceLinks}
    WHERE (resource_links.source_kind = 'session' AND NOT EXISTS (SELECT 1 FROM ${session} WHERE session_records.session_id = resource_links.source_id))
      OR (resource_links.target_kind = 'work' AND NOT EXISTS (SELECT 1 FROM ${works} WHERE works.id = resource_links.target_key))
      OR (resource_links.target_kind = 'plan' AND NOT EXISTS (SELECT 1 FROM ${session} WHERE session_records.session_id = resource_links.target_scope))
  `))
  return row.n
}
