import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/database'
import { visibleTo } from '../../admission/access'
import type { Actor } from '../../admission/actor'
import { session } from '../sessions/schema'
import { works } from './schema'

/**
 * A work takes access from the sessions it belongs to (decision 2026-10-30): the
 * session it was made in (`session_id`) and every session linked to it later
 * (`meta.sessionIds`). Who may open one of those sessions may open the work, at
 * the same role; `roleThroughSession` (admission/access.ts) decides that role.
 */

const linkRowSchema = z.object({ id: z.string(), organization_id: z.string(), session_id: z.string().nullable(), meta: z.string().nullable() })
const sessionRowSchema = z.object({ session_id: z.string(), organization_id: z.string() })
const metaSessionsSchema = z.object({ sessionIds: z.array(z.string()).optional() })

/** The sessions each work belongs to, in the work's own organization. A work with none is absent. */
export async function sessionIdsOfWorks(db: Db, workIds: readonly string[]): Promise<Map<string, string[]>> {
  const unique = [...new Set(workIds)]
  if (!unique.length) return new Map()
  const rows = linkRowSchema.array().parse(await db.all(sql`
    SELECT id, organization_id, session_id, meta FROM ${works} WHERE id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
  `))
  const named = new Map(rows.map((row) => {
    const linked = row.meta ? metaSessionsSchema.parse(JSON.parse(row.meta)).sessionIds ?? [] : []
    return [row.id, [...new Set([...(row.session_id ? [row.session_id] : []), ...linked])]]
  }))
  const sessionIds = [...new Set([...named.values()].flat())]
  if (!sessionIds.length) return new Map()
  const sessionOrganizations = new Map(sessionRowSchema.array().parse(await db.all(sql`
    SELECT session_id, organization_id FROM ${session} WHERE session_id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})
  `)).map((row) => [row.session_id, row.organization_id]))
  const sessions = new Map<string, string[]>()
  for (const row of rows) {
    const ids = named.get(row.id)!.filter((id) => sessionOrganizations.get(id) === row.organization_id)
    if (ids.length) sessions.set(row.id, ids)
  }
  return sessions
}

/**
 * `visibleTo` a session the work belongs to, as a predicate on the work's id
 * column, for list queries beside the work's own `visibleTo`.
 */
export function visibleThroughSession(db: Db, actor: Actor, workId: SQL): SQL {
  const linked = db.engine === 'postgres'
    ? sql`(owner_session.session_id = linked_work.session_id OR (linked_work.meta::jsonb->'sessionIds') ? owner_session.session_id)`
    : sql`(owner_session.session_id = linked_work.session_id OR EXISTS (SELECT 1 FROM json_each(linked_work.meta, '$.sessionIds') WHERE value = owner_session.session_id))`
  const sessionVisible = visibleTo(actor, 'session', {
    id: sql`owner_session.session_id`,
    organization: sql`owner_session.organization_id`,
    owner: sql`owner_session.created_by`,
  })
  return sql`EXISTS (SELECT 1 FROM ${works} AS linked_work JOIN ${session} AS owner_session
      ON owner_session.organization_id = linked_work.organization_id AND ${linked}
    WHERE linked_work.id = ${workId} AND ${sessionVisible})`
}
