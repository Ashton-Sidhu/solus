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

export interface LogEventRow {
  traceId: string
  spanId: string
  /** Epoch milliseconds. */
  occurredAt: number
  level: 'debug' | 'info' | 'warn' | 'error'
  name: string
  tag: string
  file: string
  attrs?: SpanAttributes
}

function insertSpan(row: SpanRow): void {
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

function insertLogEvent(row: LogEventRow): void {
  getMetricsDb().prepare(`
    INSERT INTO log_events (
      trace_id, span_id, occurred_at, level, name, tag, file, attrs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.traceId,
    row.spanId,
    row.occurredAt,
    row.level,
    row.name,
    row.tag,
    row.file,
    JSON.stringify(row.attrs ?? {}),
  )
}

/** Records one finished span. The record is append-only: a span arrives here
 *  once, when it ends. */
export function writeSpan(row: SpanRow): void {
  insertSpan(row)
}

/** Records one completed span and every structured log event it owns as one
 * transaction. A reader never observes an event without its span or a span
 * whose completed event set is only partly present. */
export function writeSpanRecord(row: SpanRow, events: LogEventRow[]): void {
  const db = getMetricsDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    insertSpan(row)
    for (const event of events) insertLogEvent(event)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Removes spans that began before the rollover cutoff. */
export function rolloverSpans(cutoff: number): number {
  const db = getMetricsDb()
  const rawRow: unknown = db.prepare('SELECT COUNT(*) AS count FROM spans WHERE started_at < ?').get(cutoff)
  // SAFETY: the aggregate statement always returns its single named row.
  const row = rawRow as { count: number }
  db.prepare('DELETE FROM spans WHERE started_at < ?').run(cutoff)
  return Number(row.count)
}
