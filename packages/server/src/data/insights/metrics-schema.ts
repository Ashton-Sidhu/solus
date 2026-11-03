import { bigint, defineTable, json, text } from '../../db/schema/define-table'

/**
 * This host's own metrics file, `metrics.db`: the spans of every turn it ran
 * and their log events (docs/database-schema.md). Generated into
 * `packages/server/drizzle/metrics` from `db/schema/metrics.ts`. Each index has
 * a reader: `spans_kind_time` the turn list, `spans_kind_name_time` the tool
 * filter, `spans_trace` a trace and the turn view's child times,
 * `spans_session` a session summary, `spans_time` the retention rollover,
 * `spans_turn_pulled` the newest pulled turn (`pulled-turns.ts`),
 * `spans_turn_open` the roots a stopped host left open (`closeAbandonedTurns`),
 * and `log_events_span_time` the cascade a rollover deletes events through.
 *
 * A turn's long texts (its prompt, system prompt, and response) and a thought's
 * text are rows of `span_texts`, not keys of `attrs`, so a list or aggregate
 * over `spans` never reads a body (plans/029 §6, P2). The root's timing
 * measures are stored when the root ends (P3); the `turns` view selects them.
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
  // The root turn's measures (`turn-measures.ts`): set when a turn's root has
  // ended and its children are known, null on every other row. Each per-kind
  // sum is a duration total over the trace's children of that kind; the two
  // semantic ones follow `trace-timing.ts`.
  provider_wait_ms: bigint(),
  thinking_time_ms: bigint(),
  tool_time_ms: bigint(),
  streaming_time_ms: bigint(),
  setup_time_ms: bigint(),
  permission_wait_ms: bigint(),
  question_wait_ms: bigint(),
  compaction_time_ms: bigint(),
  queue_wait_ms: bigint(),
  rate_limit_wait_ms: bigint(),
  settlement_time_ms: bigint(),
}, {
  indexes: [
    { name: 'spans_kind_time', columns: ['kind', 'started_at'] },
    { name: 'spans_kind_name_time', columns: ['kind', 'name', 'started_at'] },
    { name: 'spans_trace', columns: ['trace_id'] },
    { name: 'spans_session', columns: ['session_id', 'started_at'], where: 'session_id IS NOT NULL' },
    { name: 'spans_time', columns: ['started_at'] },
    { name: 'spans_turn_pulled', columns: ['started_at'], where: "kind = 'turn' AND host_id IS NOT NULL" },
    { name: 'spans_turn_open', columns: ['started_at'], where: "kind = 'turn' AND ended_at IS NULL" },
  ],
})

/** One long text of a span, by name: a turn's `prompt`, `systemPrompt`, or
 *  `response`, a thinking span's `thought`. Read by the trace view and the
 *  `turns` view's text columns through the primary key; never by an aggregate. */
export const spanTexts = defineTable('span_texts', {
  span_id: text({ notNull: true, references: { table: spans, column: 'span_id', onDelete: 'cascade' } }),
  name: text({ notNull: true }),
  text: text({ notNull: true }),
}, {
  primaryKey: ['span_id', 'name'],
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

export const METRICS_TABLES = [spans, spanTexts, logEvents] as const
