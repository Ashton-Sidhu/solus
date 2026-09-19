import type { LogEventRow, SpanRow } from '../observability/span-table'
import { appendMirror } from './mirror-log'

/**
 * The insights producer of the mirror (docs/plans/cloud-service-model.md §6).
 * A span of a session's turn tree — one that names a `sessionId` — is appended
 * with the log events it owns, once, when `metrics.db` has it. A host-internal
 * span (a boot phase, an indexer sweep, an update check) names no session and
 * stays local: the cloud shows a session's turns to its members, not a
 * machine's housekeeping. Each event carries the `event_id` the runner's table
 * assigned it, so the service can key the row the same way.
 */

/** Answers how many items were appended: one for a session span, zero otherwise. */
export function mirrorInsightSpan(span: SpanRow, events: LogEventRow[], eventIds: number[]): number {
  if (!span.sessionId) return 0
  return appendMirror('insights', [{
    key: span.spanId,
    payload: { span, events: events.map((event, index) => ({ ...event, eventId: eventIds[index] })) },
  }])
}
