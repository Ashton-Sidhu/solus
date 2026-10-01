import { bigint, defineTable, json, text } from '../../db/schema/define-table'

/**
 * The mirrored Insights tables on the collaboration plane
 * (docs/plans/cloud-service-model.md §6). A runner appends what it produces to
 * its local mirror log and ships it in order; these are where spans and log
 * events land on the workspace service — and, on a signed-out host, where
 * nothing lands, because a host reads its own metrics database directly.
 * Every row names its organization and the runner it came from.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

/** A finished span of a runner's turn tree, the same columns `metrics.db` keeps. */
export const insightSpans = defineTable('insight_spans', {
  organization_id: ORGANIZATION,
  host_id: text({ notNull: true }),
  span_id: text({ notNull: true }),
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
  /** Attribution (organization-scope §6.1): the verified acting account, as the runner recorded it. */
  user_id: text(),
  user_email: text(),
  started_at: bigint({ notNull: true }),
  ended_at: bigint({ notNull: true }),
  duration_ms: bigint({ notNull: true }),
  status: text({ notNull: true }),
  attrs: json({ notNull: true, default: '{}' }),
}, {
  primaryKey: ['organization_id', 'host_id', 'span_id'],
  indexes: [
    { name: 'insight_turns_page', columns: ['organization_id', 'started_at', 'host_id', 'trace_id'], descending: ['started_at', 'host_id', 'trace_id'], where: "kind = 'turn' AND span_id = trace_id" },
    { name: 'insight_turns_user_page', columns: ['organization_id', 'user_id', 'started_at', 'host_id', 'trace_id'], descending: ['started_at', 'host_id', 'trace_id'], where: "kind = 'turn' AND span_id = trace_id" },
    { name: 'insight_turns_host_page', columns: ['organization_id', 'host_id', 'started_at', 'trace_id'], descending: ['started_at', 'trace_id'], where: "kind = 'turn' AND span_id = trace_id" },
    { name: 'insight_turns_session_page', columns: ['organization_id', 'session_id', 'started_at', 'host_id', 'trace_id'], descending: ['started_at', 'host_id', 'trace_id'], where: "kind = 'turn' AND span_id = trace_id" },
    { name: 'insight_turns_provider_page', columns: ['organization_id', 'provider', 'started_at', 'host_id', 'trace_id'], descending: ['started_at', 'host_id', 'trace_id'], where: "kind = 'turn' AND span_id = trace_id" },
    // One turn's tree, read when its owner opens it on another host.
    { name: 'insight_spans_trace_idx', columns: ['organization_id', 'host_id', 'trace_id'] },
    // Retention prunes by time across every organization.
    { name: 'insight_spans_time_idx', columns: ['started_at'] },
  ],
})

/** A structured log event a mirrored span owns. */
export const insightLogEvents = defineTable('insight_log_events', {
  organization_id: ORGANIZATION,
  host_id: text({ notNull: true }),
  /** The runner's own event id, unique per host. */
  event_id: bigint({ notNull: true }),
  trace_id: text({ notNull: true }),
  span_id: text({ notNull: true }),
  occurred_at: bigint({ notNull: true }),
  level: text({ notNull: true }),
  name: text({ notNull: true }),
  tag: text({ notNull: true }),
  file: text({ notNull: true }),
  attrs: json({ notNull: true, default: '{}' }),
}, {
  primaryKey: ['organization_id', 'host_id', 'event_id'],
  indexes: [
    { name: 'insight_log_events_time_idx', columns: ['occurred_at'] },
    { name: 'insight_log_events_trace_idx', columns: ['organization_id', 'host_id', 'trace_id'] },
  ],
})
