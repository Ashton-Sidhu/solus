import { bigint, defineTable, integer, json, text } from '../db/schema/define-table'

/**
 * The mirrored domains' tables on the collaboration plane
 * (docs/plans/cloud-service-model.md §6). A runner appends what it produces to
 * its local mirror log and ships it in order; these are where the items land
 * on the workspace service — and, on a signed-out host, where nothing lands,
 * because a host reads its own transcript files and metrics database directly.
 * Every row names its organization and the runner it came from.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

/**
 * One history row of a session's transcript, as the runner's reader produced
 * it: a `SessionLoadMessage` at its position. A position is written again when
 * the row changed (a tool call that finished after its row was first
 * mirrored), so the key is the position and the payload is the latest.
 */
export const sessionTranscripts = defineTable('session_transcripts', {
  organization_id: ORGANIZATION,
  session_id: text({ notNull: true }),
  position: integer({ notNull: true }),
  runner_host_id: text({ notNull: true }),
  message: json({ notNull: true }),
  updated_at: bigint({ notNull: true }),
}, {
  primaryKey: ['organization_id', 'session_id', 'position'],
})

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
  started_at: bigint({ notNull: true }),
  ended_at: bigint({ notNull: true }),
  duration_ms: bigint({ notNull: true }),
  status: text({ notNull: true }),
  attrs: json({ notNull: true, default: '{}' }),
}, {
  primaryKey: ['organization_id', 'host_id', 'span_id'],
  indexes: [
    { name: 'insight_spans_session_idx', columns: ['organization_id', 'session_id', 'started_at'], where: 'session_id IS NOT NULL' },
    { name: 'insight_spans_time_idx', columns: ['organization_id', 'started_at'] },
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
    { name: 'insight_log_events_span_idx', columns: ['organization_id', 'host_id', 'span_id', 'occurred_at'] },
  ],
})

export const MIRROR_TABLES = [sessionTranscripts, insightSpans, insightLogEvents]
