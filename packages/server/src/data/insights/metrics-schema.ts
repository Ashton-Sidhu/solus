import { bigint, defineTable, json, text } from '../../db/schema/define-table'

/**
 * This host's own metrics file, `metrics.db`: the spans of every turn it ran
 * and their log events (docs/database-schema.md). Generated into
 * `packages/server/drizzle/metrics` from `db/schema/metrics.ts`. Each index has
 * a reader: `spans_kind_time` the turn list, `spans_kind_name_time` the tool
 * filter, `spans_trace` a trace and the turn view's child times,
 * `spans_session` a session summary, `spans_time` the retention rollover, and
 * `log_events_span_time` the cascade a rollover deletes events through.
 */
export const spans = defineTable('spans', {
  span_id: text({ primaryKey: true }),
  parent_span_id: text(),
  trace_id: text({ notNull: true }),
  kind: text({ notNull: true }),
  name: text({ notNull: true }),
  service: text({ notNull: true }),
  session_id: text(),
  provider: text(),
  model: text(),
  project_root: text(),
  origin: text(),
  started_at: bigint({ notNull: true }),
  ended_at: bigint(),
  duration_ms: bigint(),
  status: text({ notNull: true }),
  attrs: json({ notNull: true, default: '{}' }),
  /** Attribution (docs/plans/organization-scope.md §6.1): who ran the turn, as the host verified them. */
  user_id: text(),
  user_email: text(),
  organization_id: text(),
  /** The host that ran the span (docs/plans/insights-across-hosts.md): set on a pulled turn, null on this host's own. */
  host_id: text(),
}, {
  indexes: [
    { name: 'spans_kind_time', columns: ['kind', 'started_at'] },
    { name: 'spans_kind_name_time', columns: ['kind', 'name', 'started_at'] },
    { name: 'spans_trace', columns: ['trace_id'] },
    { name: 'spans_session', columns: ['session_id', 'started_at'], where: 'session_id IS NOT NULL' },
    { name: 'spans_time', columns: ['started_at'] },
  ],
})

export const logEvents = defineTable('log_events', {
  event_id: bigint({ primaryKey: true }),
  trace_id: text({ notNull: true }),
  span_id: text({ notNull: true, references: { table: spans, column: 'span_id', onDelete: 'cascade' } }),
  occurred_at: bigint({ notNull: true }),
  level: text({ notNull: true }),
  name: text({ notNull: true }),
  tag: text({ notNull: true }),
  file: text({ notNull: true }),
  attrs: json({ notNull: true, default: '{}' }),
}, {
  indexes: [
    { name: 'log_events_trace_time', columns: ['trace_id', 'occurred_at'] },
    { name: 'log_events_span_time', columns: ['span_id', 'occurred_at'] },
  ],
})

export const METRICS_TABLES = [spans, logEvents] as const
