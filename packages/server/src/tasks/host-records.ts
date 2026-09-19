import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { getDatabase } from '../db/database'
import { works } from '../folio/schema'
import { planAnnotations } from '../plans/schema'

/**
 * The display fields tasks read from domains that are not ported yet
 * (docs/plans/cloud-service-model.md): a linked session's name and provider,
 * and the live title of a linked work, automation, or plan.
 *
 * Those tables still live in the host's SQLite file, so every read here goes
 * through `getDb()` on either engine and is a separate statement, never a JOIN
 * from a tasks query. When a domain is ported, its read moves out of this file
 * and back into the tasks query it belongs to.
 */

const sessionRecordRowSchema = z.object({
  session_id: z.string(),
  session_title: z.string().nullable(),
  session_provider: z.enum(['claude', 'claude-code', 'codex', 'opencode']).nullable(),
  session_model: z.string().nullable(),
  session_server_id: z.string().nullable(),
  branch: z.string().nullable(),
  session_is_worktree: z.number().nullable(),
  session_started_at: z.number().nullable(),
  last_activity_at: z.number().nullable(),
})

export type SessionRecord = z.infer<typeof sessionRecordRowSchema>

/** A session's display metadata, keyed by the id a task link holds. A session
 * that is not in the index yet has no entry. The link may hold the stable Solus
 * id while the index is keyed by the provider's thread, so the lineage's active
 * member decides which indexed row answers. */
export function sessionRecordsFor(sessionIds: Iterable<string>): Map<string, SessionRecord> {
  const ids = [...new Set(sessionIds)]
  const records = new Map<string, SessionRecord>()
  if (!ids.length) return records
  const rows = sessionRecordRowSchema.array().parse(getDb().prepare(`
    SELECT
      ids.session_id,
      COALESCE(sessions.custom_title, sessions.first_message) AS session_title,
      sessions.provider AS session_provider,
      sessions.model AS session_model,
      sessions.server_id AS session_server_id,
      sessions.branch AS branch,
      sessions.is_worktree AS session_is_worktree,
      (
        SELECT MIN(started_at)
        FROM session_lineage_members
        WHERE session_id = ids.session_id
      ) AS session_started_at,
      sessions.last_timestamp AS last_activity_at
    FROM (SELECT value AS session_id FROM json_each(?)) AS ids
    LEFT JOIN session_lineage_members AS active_lineage
      ON active_lineage.session_id = ids.session_id
      AND active_lineage.position = (
        SELECT MAX(position)
        FROM session_lineage_members
        WHERE session_id = ids.session_id
      )
    LEFT JOIN sessions
      ON sessions.session_id = COALESCE(active_lineage.provider_session_id, ids.session_id)
  `).all(JSON.stringify(ids)))
  for (const row of rows) records.set(row.session_id, row)
  return records
}

/** The name a session shows, or null when it was never indexed. */
export function sessionTitleFor(sessionId: string): string | null {
  const row = z.object({ title: z.string().nullable() }).nullish().parse(getDb().prepare(
    'SELECT COALESCE(custom_title, first_message) AS title FROM sessions WHERE session_id = ?',
  ).get(sessionId))
  return row?.title ?? null
}

export interface LinkTargetRecord {
  title: string | null
  /** A work's type, an automation's `Active`/`Paused`, or a plan's review status. */
  status: string | null
}

export interface LinkTargetKey {
  kind: string
  targetScope: string
  targetKey: string
}

const workRowSchema = z.object({ id: z.string(), title: z.string().nullable(), type: z.string().nullable() })
const automationRowSchema = z.object({ id: z.string(), name: z.string().nullable(), enabled: z.number().nullable() })
const planRowSchema = z.object({
  session_id: z.string(),
  plan_tool_use_id: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
})

export function linkTargetRecordKey(target: LinkTargetKey): string {
  return `${target.kind}\0${target.targetScope}\0${target.targetKey}`
}

/** Live title and status per linked target. Works and plans are ported
 * domains, so their reads are `Db` queries scoped to the organization;
 * automations still live in the host's file. `pr` targets are a GitHub round
 * trip and are never looked up here. */
export async function linkTargetRecordsFor(organizationId: string, targets: LinkTargetKey[]): Promise<Map<string, LinkTargetRecord>> {
  const records = new Map<string, LinkTargetRecord>()
  const workIds = [...new Set(targets.filter((target) => target.kind === 'work').map((target) => target.targetKey))]
  const automationIds = [...new Set(targets.filter((target) => target.kind === 'automation').map((target) => target.targetKey))]
  const plans = targets.filter((target) => target.kind === 'plan')
  const db = getDb()
  if (workIds.length) {
    const rows = workRowSchema.array().parse(await getDatabase().all(sql`
      SELECT id, title, type FROM ${works}
      WHERE organization_id = ${organizationId}
        AND id IN (${sql.join(workIds.map((id) => sql`${id}`), sql`, `)})
    `))
    for (const row of rows) {
      records.set(linkTargetRecordKey({ kind: 'work', targetScope: '', targetKey: row.id }), { title: row.title, status: row.type })
    }
  }
  if (automationIds.length) {
    const rows = automationRowSchema.array().parse(db.prepare(
      'SELECT id, name, enabled FROM automations WHERE id IN (SELECT value FROM json_each(?))',
    ).all(JSON.stringify(automationIds)))
    for (const row of rows) {
      records.set(linkTargetRecordKey({ kind: 'automation', targetScope: '', targetKey: row.id }), {
        title: row.name,
        status: row.enabled === null ? null : row.enabled === 1 ? 'Active' : 'Paused',
      })
    }
  }
  if (plans.length) {
    const wanted = sql.join(
      plans.map((plan) => sql`(session_id = ${plan.targetScope} AND plan_tool_use_id = ${plan.targetKey})`),
      sql` OR `,
    )
    const rows = planRowSchema.array().parse(await getDatabase().all(sql`
      SELECT session_id, plan_tool_use_id, title, status
      FROM ${planAnnotations}
      WHERE organization_id = ${organizationId} AND (${wanted})
    `))
    for (const row of rows) {
      records.set(linkTargetRecordKey({ kind: 'plan', targetScope: row.session_id, targetKey: row.plan_tool_use_id }), {
        title: row.title,
        status: row.status,
      })
    }
  }
  return records
}
