import { Buffer } from 'node:buffer'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  workspaceInsightAttributesSchema,
  type WorkspaceInsight, type WorkspaceInsightQuery, type WorkspaceInsightTree,
} from '@solus/contracts/solus-api'
import { getDatabase } from '../../db/database'
import { insightLogEvents, insightSpans } from './insight-schema'

const rowSchema = z.object({
  trace_id: z.string(), host_id: z.string(), session_id: z.string().nullable(),
  user_id: z.string().nullable(), user_email: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable(),
  started_at: z.number(), ended_at: z.number(), duration_ms: z.number(), status: z.string(), attrs: z.string(),
  name: z.string(), service: z.string(), origin: z.string().nullable(), project_root: z.string().nullable(),
})
const measuresSchema = z.object({ costUsd: z.number().finite().nonnegative().nullish(), inputTokens: z.number().int().nonnegative().nullish(), outputTokens: z.number().int().nonnegative().nullish() })
/** A turn row carries the start of its prompt; the tree carries all of it. */
const PROMPT_PREVIEW_CHARS = 200
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

function parsedAttributes(json: string): z.infer<typeof workspaceInsightAttributesSchema> {
  try { return workspaceInsightAttributesSchema.parse(JSON.parse(json)) } catch { return {} }
}

/** The root's attributes as a turn row, with the prompt cut short. */
function rowAttributes(row: z.infer<typeof rowSchema>): z.infer<typeof workspaceInsightAttributesSchema> {
  const attrs = parsedAttributes(row.attrs)
  const prompt = z.string().safeParse(attrs.prompt)
  delete attrs.prompt
  if (prompt.success) {
    attrs.prompt = prompt.data.slice(0, PROMPT_PREVIEW_CHARS)
    if (prompt.data.length > PROMPT_PREVIEW_CHARS) attrs.promptTruncated = true
  }
  return attrs
}

function turn(row: z.infer<typeof rowSchema>): WorkspaceInsight {
  const attrs = rowAttributes(row)
  const measures = measuresSchema.safeParse(attrs)
  const attributes = measures.success ? measures.data : {}
  return {
    id: insightIdentity(row.host_id, row.trace_id), traceId: row.trace_id, hostId: row.host_id, sessionId: row.session_id,
    userId: row.user_id, userEmail: row.user_email, provider: row.provider, model: row.model,
    startedAt: new Date(row.started_at).toISOString(), endedAt: row.ended_at > 0 ? new Date(row.ended_at).toISOString() : null,
    durationMs: row.duration_ms, status: row.status,
    costUsd: attributes.costUsd ?? null, inputTokens: attributes.inputTokens ?? null, outputTokens: attributes.outputTokens ?? null,
    name: row.name, service: row.service, origin: row.origin, projectRoot: row.project_root, attrs,
  }
}

function columns(): SQL {
  // The two long texts of a root (the response and the system prompt) never leave storage.
  const attrs = getDatabase().engine === 'postgres'
    ? sql`CAST(attrs::jsonb - 'response' - 'systemPrompt' AS TEXT)`
    : sql`json_remove(attrs, '$.response', '$.systemPrompt')`
  return sql`trace_id, host_id, session_id, user_id, user_email, provider, model, started_at, ended_at, duration_ms, status, ${attrs} AS attrs, name, service, origin, project_root`
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

const spanRowSchema = z.object({
  span_id: z.string(), parent_span_id: z.string().nullable(), trace_id: z.string(), kind: z.string(), name: z.string(), service: z.string(),
  session_id: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable(), project_root: z.string().nullable(),
  origin: z.string().nullable(), user_id: z.string().nullable(), user_email: z.string().nullable(),
  started_at: z.number(), ended_at: z.number(), status: z.string(), attrs: z.string(),
})
const eventRowSchema = z.object({
  span_id: z.string(), occurred_at: z.number(), level: z.enum(['debug', 'info', 'warn', 'error']), name: z.string(), tag: z.string(), file: z.string(), attrs: z.string(),
})

/**
 * Every span and log event of one turn, with all of its attributes: what the
 * Insights page shows of a turn, for any member of its organization.
 */
export async function getApiInsightTree(organizationId: string, id: string): Promise<WorkspaceInsightTree | null> {
  const identity = parseInsightIdentity(id)
  if (!identity) return null
  const [hostId, traceId] = identity
  const db = getDatabase()
  const root = await db.get(sql`
    SELECT 1 AS found FROM ${insightSpans}
    WHERE organization_id = ${organizationId} AND host_id = ${hostId} AND span_id = ${traceId} AND ${rootTurn}
  `)
  if (!root) return null
  const spans = spanRowSchema.array().parse(await db.all(sql`
    SELECT span_id, parent_span_id, trace_id, kind, name, service, session_id, provider, model, project_root, origin,
      user_id, user_email, started_at, ended_at, status, CAST(attrs AS TEXT) AS attrs
    FROM ${insightSpans} WHERE organization_id = ${organizationId} AND host_id = ${hostId} AND trace_id = ${traceId}
    ORDER BY started_at, span_id
  `))
  const events = eventRowSchema.array().parse(await db.all(sql`
    SELECT span_id, occurred_at, level, name, tag, file, CAST(attrs AS TEXT) AS attrs
    FROM ${insightLogEvents} WHERE organization_id = ${organizationId} AND host_id = ${hostId} AND trace_id = ${traceId}
    ORDER BY occurred_at, event_id
  `))
  return {
    spans: spans.map(span => ({
      spanId: span.span_id, parentSpanId: span.parent_span_id, traceId: span.trace_id, kind: span.kind, name: span.name, service: span.service,
      sessionId: span.session_id, provider: span.provider, model: span.model, projectRoot: span.project_root, origin: span.origin,
      userId: span.user_id, userEmail: span.user_email, startedAt: span.started_at, endedAt: span.ended_at, status: span.status,
      attrs: parsedAttributes(span.attrs),
    })),
    events: events.map(event => ({
      spanId: event.span_id, occurredAt: event.occurred_at, level: event.level, name: event.name, tag: event.tag, file: event.file,
      attrs: parsedAttributes(event.attrs),
    })),
  }
}

/** Drops mirrored spans and events older than `cutoff`, as the metrics file drops its own. */
export async function pruneMirroredInsights(cutoff: number): Promise<void> {
  const db = getDatabase()
  await db.run(sql`DELETE FROM ${insightLogEvents} WHERE occurred_at < ${cutoff}`)
  await db.run(sql`DELETE FROM ${insightSpans} WHERE started_at < ${cutoff}`)
}
