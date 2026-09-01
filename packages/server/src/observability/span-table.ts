import { getMetricsDb } from './metrics-db'
import type {
  SpanAttributes,
  SpanDimensions,
  SpanKind,
  SpanService,
  SpanStatus,
} from './registries'

// ─── The `spans` table ───
//
// One row per finished span, and the only two things anybody does to it: write
// a span when it ends, and drop spans older than the retention window.
//
// Every id and timestamp is required, because every one of them is decided
// before a row gets here — the tracer mints the ids, and Solus decides the
// times a span covers. Nothing invents either at the table.

export interface SpanRow extends SpanDimensions {
  spanId: string
  /** Absent on a trace root. */
  parentSpanId?: string
  traceId: string
  kind: SpanKind
  name: string
  service: SpanService
  /** Epoch milliseconds. */
  startedAt: number
  endedAt: number
  status: SpanStatus
  attrs?: SpanAttributes
}

/** Records one finished span. The record is append-only: a span arrives here
 *  once, when it ends. */
export function writeSpan(row: SpanRow): void {
  getMetricsDb().prepare(`
    INSERT INTO spans (
      span_id, parent_span_id, trace_id, kind, name, service,
      session_id, provider, model, project_root, origin,
      started_at, ended_at, duration_ms, status, attrs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.spanId,
    row.parentSpanId ?? null,
    row.traceId,
    row.kind,
    row.name,
    row.service,
    row.sessionId ?? null,
    row.provider ?? null,
    row.model ?? null,
    row.projectRoot ?? null,
    row.origin ?? null,
    row.startedAt,
    row.endedAt,
    row.endedAt - row.startedAt,
    row.status,
    JSON.stringify(row.attrs ?? {}),
  )
}

/** Removes spans that began before the rollover cutoff. */
export function rolloverSpans(cutoff: number): number {
  return getMetricsDb().prepare('DELETE FROM spans WHERE started_at < ?').run(cutoff).changes
}
