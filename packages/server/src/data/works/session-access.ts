import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/database'
import { visibleTo } from '../../admission/access'
import type { Actor } from '../../admission/actor'
import { resourceLinks } from '../links/schema'
import { session } from '../sessions/schema'
import { works } from './schema'

/**
 * A work takes access from the sessions it belongs to (decision 2026-10-30): the
 * session it was made in (`session_id`, which needs no edge) and every session
 * that is a `member` of it in `resource_links`. Who may open one of those
 * sessions may open the work, at the same role; `roleThroughSession`
 * (admission/access.ts) decides that role.
 */

/** A work with one of its members, or with none (`member_session_id` null). */
const workMemberRowSchema = z.object({ id: z.string(), organization_id: z.string(), session_id: z.string().nullable(), member_session_id: z.string().nullable() })
const sessionRowSchema = z.object({ session_id: z.string(), organization_id: z.string() })

/** A session's membership of a work, as a predicate on the work's id and the session's id. */
export function workMembership(workId: SQL, sessionId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM ${resourceLinks} AS member
    WHERE member.source_kind = 'session' AND member.source_id = ${sessionId} AND member.target_kind = 'work'
      AND member.target_key = ${workId} AND member.relation = 'member' AND member.status = 'active')`
}

/** The sessions each work belongs to, in the work's own organization. A work with none is absent. */
export async function sessionIdsOfWorks(db: Db, workIds: readonly string[]): Promise<Map<string, string[]>> {
  const unique = [...new Set(workIds)]
  if (!unique.length) return new Map()
  // One read of the works with their members: the origin on the row, each member an edge.
  const rows = workMemberRowSchema.array().parse(await db.all(sql`
    SELECT works.id, works.organization_id, works.session_id, member.source_id AS member_session_id
    FROM ${works}
    LEFT JOIN ${resourceLinks} AS member ON member.source_kind = 'session' AND member.target_kind = 'work'
      AND member.relation = 'member' AND member.status = 'active' AND member.target_key = works.id
    WHERE works.id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
    ORDER BY member.created_at
  `))
  const named = new Map<string, { organizationId: string; sessionIds: string[] }>()
  for (const row of rows) {
    const work = named.get(row.id) ?? { organizationId: row.organization_id, sessionIds: row.session_id ? [row.session_id] : [] }
    if (row.member_session_id && !work.sessionIds.includes(row.member_session_id)) work.sessionIds.push(row.member_session_id)
    named.set(row.id, work)
  }
  const sessionIds = [...new Set([...named.values()].flatMap((work) => work.sessionIds))]
  if (!sessionIds.length) return new Map()
  const sessionOrganizations = new Map(sessionRowSchema.array().parse(await db.all(sql`
    SELECT session_id, organization_id FROM ${session} WHERE session_id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})
  `)).map((row) => [row.session_id, row.organization_id]))
  const sessions = new Map<string, string[]>()
  for (const [workId, work] of named) {
    const linked = work.sessionIds.filter((id) => sessionOrganizations.get(id) === work.organizationId)
    if (linked.length) sessions.set(workId, linked)
  }
  return sessions
}

/**
 * `visibleTo` a session the work belongs to, as a predicate on the work's id
 * column, for list queries beside the work's own `visibleTo`.
 */
export function visibleThroughSession(actor: Actor, workId: SQL): SQL {
  const linked = sql`(owner_session.session_id = linked_work.session_id OR ${workMembership(sql`linked_work.id`, sql`owner_session.session_id`)})`
  const sessionVisible = visibleTo(actor, 'session', {
    id: sql`owner_session.session_id`,
    organization: sql`owner_session.organization_id`,
    owner: sql`owner_session.created_by`,
  })
  return sql`EXISTS (SELECT 1 FROM ${works} AS linked_work JOIN ${session} AS owner_session
      ON owner_session.organization_id = linked_work.organization_id AND ${linked}
    WHERE linked_work.id = ${workId} AND ${sessionVisible})`
}
