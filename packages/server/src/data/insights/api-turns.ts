import { Buffer } from 'node:buffer'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { WorkspaceInsight, WorkspaceInsightQuery } from '@solus/contracts/solus-api'
import { getDatabase } from '../../db/database'
import { insightLogEvents, insightSpans } from './insight-schema'

const rowSchema = z.object({
  trace_id: z.string(), host_id: z.string(), session_id: z.string().nullable(),
  user_id: z.string().nullable(), user_email: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable(),
  started_at: z.number(), ended_at: z.number(), duration_ms: z.number(), status: z.string(), attrs: z.string(),
})
const attributesSchema = z.object({ costUsd: z.number().finite().nonnegative().nullish(), inputTokens: z.number().int().nonnegative().nullish(), outputTokens: z.number().int().nonnegative().nullish() })
const identitySchema = z.tuple([z.string().min(1).max(256), z.string().min(1).max(256)])
export interface InsightPosition { time: number; id: string; hostId?: string }

/** Mirrored span identity includes its source host; trace IDs alone are not a database key. */
export function insightIdentity(hostId: string, traceId: string): string {
  return Buffer.from(JSON.stringify([hostId, traceId])).toString('base64url')
}

export function parseInsightIdentity(id: string): [string, string] | null {
  if (!id || id.length > 1024) return null
  try {
    const parsed = identitySchema.safeParse(JSON.parse(Buffer.from(id, 'base64url').toString('utf8')))
    return parsed.success && insightIdentity(...parsed.data) === id ? parsed.data : null
  } catch { return null }
}

function turn(row: z.infer<typeof rowSchema>): WorkspaceInsight {
  let attributes: z.infer<typeof attributesSchema> = {}
  try { attributes = attributesSchema.parse(JSON.parse(row.attrs)) } catch { /* Invalid observations remain unknown. */ }
  return {
    id: insightIdentity(row.host_id, row.trace_id), traceId: row.trace_id, hostId: row.host_id, sessionId: row.session_id,
    userId: row.user_id, userEmail: row.user_email, provider: row.provider, model: row.model,
    startedAt: new Date(row.started_at).toISOString(), endedAt: row.ended_at > 0 ? new Date(row.ended_at).toISOString() : null,
    durationMs: row.duration_ms, status: row.status,
    costUsd: attributes.costUsd ?? null, inputTokens: attributes.inputTokens ?? null, outputTokens: attributes.outputTokens ?? null,
  }
}

function columns(): SQL {
  // Discard prompt/tool attributes inside SQL; only three scalar measurements leave storage.
  const fields = ['costUsd', 'inputTokens', 'outputTokens']
  const values = fields.flatMap(name => [sql`CAST(${name} AS TEXT)`, getDatabase().engine === 'postgres'
    ? sql`CASE WHEN jsonb_typeof(attrs::jsonb->${name}) = 'number' THEN attrs::jsonb->${name} ELSE NULL END`
    : sql`CASE WHEN json_type(attrs, ${'$.' + name}) IN ('integer', 'real') THEN json_extract(attrs, ${'$.' + name}) ELSE NULL END`])
  const attrs = getDatabase().engine === 'postgres'
    ? sql`CAST(jsonb_build_object(${sql.join(values, sql`, `)}) AS TEXT)`
    : sql`json_object(${sql.join(values, sql`, `)})`
  return sql`trace_id, host_id, session_id, user_id, user_email, provider, model, started_at, ended_at, duration_ms, status, ${attrs} AS attrs`
}
const rootTurn = sql`kind = 'turn' AND span_id = trace_id`

/** One indexed seek; no full result materialization, OFFSET, COUNT or SUM. */
export async function listApiInsights(
  organizationId: string, query: WorkspaceInsightQuery, since: number, until: number, after?: InsightPosition,
): Promise<WorkspaceInsight[]> {
  const filters: SQL[] = [sql`organization_id = ${organizationId}`, rootTurn, sql`started_at >= ${since}`, sql`started_at < ${until}`]
  if (query.userId) filters.push(sql`user_id = ${query.userId}`)
  if (query.hostId) filters.push(sql`host_id = ${query.hostId}`)
  if (query.sessionId) filters.push(sql`session_id = ${query.sessionId}`)
  if (query.provider) filters.push(sql`provider = ${query.provider}`)
  if (after) filters.push(sql`(started_at, host_id, trace_id) < (${after.time}, ${after.hostId ?? ''}, ${after.id})`)
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${columns()} FROM ${insightSpans} WHERE ${sql.join(filters, sql` AND `)}
    ORDER BY started_at DESC, host_id DESC, trace_id DESC LIMIT ${query.limit + 1}
  `))
  return rows.map(turn)
}

export async function getApiInsight(organizationId: string, id: string): Promise<WorkspaceInsight | null> {
  const identity = parseInsightIdentity(id)
  if (!identity) return null
  const [hostId, traceId] = identity
  const row = rowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT ${columns()} FROM ${insightSpans}
    WHERE organization_id = ${organizationId} AND host_id = ${hostId} AND span_id = ${traceId} AND ${rootTurn}
  `))
  return row ? turn(row) : null
}

/** Drops mirrored spans and events older than `cutoff`, as the metrics file drops its own. */
export async function pruneMirroredInsights(cutoff: number): Promise<void> {
  const db = getDatabase()
  await db.run(sql`DELETE FROM ${insightLogEvents} WHERE occurred_at < ${cutoff}`)
  await db.run(sql`DELETE FROM ${insightSpans} WHERE started_at < ${cutoff}`)
}
