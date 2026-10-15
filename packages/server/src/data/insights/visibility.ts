import { sql } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { visibleTo } from '../../admission/access'
import type { Actor } from '../../admission/actor'
import { getReadOnlyMetricsDb } from './metrics-db'

/** A WHERE condition on `spans` or one of its views, with the values its placeholders bind. */
export interface InsightFilter {
  sql: string
  params: Array<string | number>
}

const dialect = new SQLiteSyncDialect()

/**
 * The spans `actor` may read in Insights (docs/plans/access-model.md §4 D2): a
 * person reads the turns they ran; a host administrator reads every turn in
 * their scope. A span names its person in `user_id` (null for the host's own
 * work, which only an administrator reads) and its organization in
 * `organization_id` (null is Local). Every view of `spans` has these columns.
 */
export function visibleInsights(actor: Actor): InsightFilter {
  const predicate = visibleTo(actor, 'insight', { id: sql`span_id`, organization: sql`COALESCE(organization_id, 'local')`, owner: sql`user_id` })
  const { sql: text, params } = dialect.sqlToQuery(predicate)
  // SAFETY: the predicate binds only person keys and organization ids, which are strings.
  return { sql: text, params: params as string[] }
}

/** Whether the filter reaches a trace: its root span, the turn, is one the reader may read. */
export function traceVisible(traceId: string, visible: InsightFilter): boolean {
  return Boolean(getReadOnlyMetricsDb()
    .prepare(`SELECT 1 FROM spans WHERE trace_id = ? AND span_id = trace_id AND ${visible.sql}`)
    .get(traceId, ...visible.params))
}
