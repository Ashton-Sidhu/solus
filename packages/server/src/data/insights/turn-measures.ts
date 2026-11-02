import type { DatabaseSync } from 'node:sqlite'
import { SPAN_KINDS } from './registries'
import { turnMeasures, type TimedSpan } from './trace-timing'

// ─── A turn root's stored measures ───
//
// The `turns` view used to compute provider wait, Thinking time, and each
// per-kind child sum with a correlated query per row, so an aggregate over the
// view re-walked every trace. A root's measures are final once it has ended and
// its children are written, so they are computed then, once, and stored on the
// root (plans/029 §6, P3). Every write of a span whose root has ended recomputes
// them, so a child that ends after its root cannot leave a stale value.

interface TimedRow {
  span_id: string
  kind: string
  started_at: number
  ended_at: number | null
  duration_ms: number | null
}

function toTimedSpan(row: TimedRow): TimedSpan {
  return {
    spanId: row.span_id,
    kind: row.kind,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
  }
}

/**
 * Stores the root turn's measures for `traceId` from the spans now in the
 * table. A no-op, answering false, while the root is open or the trace has no
 * turn root. Runs on the caller's connection, inside its transaction.
 */
export function storeTurnMeasures(db: DatabaseSync, traceId: string): boolean {
  const rawRows: unknown = db.prepare(`
    SELECT span_id, kind, started_at, ended_at, duration_ms FROM spans WHERE trace_id = ?
  `).all(traceId)
  // SAFETY: the SELECT names exactly the columns `TimedRow` declares.
  const rows = rawRows as TimedRow[]
  const root = rows.find((row) => row.span_id === traceId && row.kind === SPAN_KINDS.turn)
  if (!root || root.ended_at === null) return false
  const children = rows.filter((row) => row.span_id !== traceId).map(toTimedSpan)
  const measures = turnMeasures({ startedAt: root.started_at, endedAt: root.ended_at }, children)
  db.prepare(`
    UPDATE spans SET
      provider_wait_ms = ?, thinking_time_ms = ?, tool_time_ms = ?, streaming_time_ms = ?,
      setup_time_ms = ?, permission_wait_ms = ?, question_wait_ms = ?, compaction_time_ms = ?,
      queue_wait_ms = ?, rate_limit_wait_ms = ?, settlement_time_ms = ?
    WHERE span_id = ?
  `).run(
    measures.providerWaitMs,
    measures.thinkingTimeMs,
    measures.toolTimeMs,
    measures.streamingTimeMs,
    measures.setupTimeMs,
    measures.permissionWaitMs,
    measures.questionWaitMs,
    measures.compactionTimeMs,
    measures.queueWaitMs,
    measures.rateLimitWaitMs,
    measures.settlementTimeMs,
    traceId,
  )
  return true
}
