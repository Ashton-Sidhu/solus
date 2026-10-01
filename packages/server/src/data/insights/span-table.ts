import { createLogger } from '../../logger'
import { getMetricsDb } from './metrics-db'
import {
  SPAN_KINDS,
  type SpanAttributes,
  type SpanDimensions,
  type SpanKind,
  type SpanService,
  type SpanStatus,
} from './registries'

const log = createLogger('SpanTable', 'span-table.ts')

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

/** A span that has started and not ended: what a running turn's root is
 *  while the turn runs. It has no end, no duration, and no status yet. */
export type OpenSpanRow = Omit<SpanRow, 'endedAt' | 'status'>

/** A turn's root row as it now stands in the table. */
export interface TurnRowWritten {
  traceId: string
  sessionId: string | null
  status: SpanStatus
}

type TurnRowListener = (change: TurnRowWritten) => void
const turnRowListeners = new Set<TurnRowListener>()

/** Every write of a turn's root row — open at start, finished at end — is
 *  announced after it commits, so a reader told about it reads the new row. */
export function onTurnRowWritten(listener: TurnRowListener): () => void {
  turnRowListeners.add(listener)
  return () => turnRowListeners.delete(listener)
}

export function announceTurnRow(row: Pick<OpenSpanRow, 'traceId' | 'sessionId'>, status: SpanStatus): void {
  const change: TurnRowWritten = { traceId: row.traceId, sessionId: row.sessionId ?? null, status }
  for (const listener of turnRowListeners) {
    try {
      listener(change)
    } catch (error) {
      log.warn('turn_row_listener_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Records a span that is still running, so a reader can see the turn while it
 * happens. The finished span replaces this row when it ends (`insertSpan` is a
 * replace on the same key), and a row that already exists is left alone: an
 * end that raced the start must not be overwritten by the start.
 */
export function writeOpenSpan(row: OpenSpanRow): void {
  const result = getMetricsDb().prepare(`
    INSERT OR IGNORE INTO spans (
      span_id, parent_span_id, trace_id, kind, name, service,
      session_id, provider, model, project_root, origin,
      user_id, user_email, organization_id,
      started_at, ended_at, duration_ms, status, attrs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'unknown', ?)
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
    row.userId ?? null,
    row.userEmail ?? null,
    row.organizationId ?? null,
    row.startedAt,
    JSON.stringify(row.attrs ?? {}),
  )
  // An ignored insert changed nothing: the finished row is already there.
  if (row.kind === SPAN_KINDS.turn && Number(result.changes) > 0) announceTurnRow(row, 'unknown')
}

/**
 * Rewrites a running span's open row with what it learned since it started —
 * the executed model, the task it runs under. Only a row that is still open is
 * touched: once the finished span is written, it is the record.
 */
export function updateOpenSpan(row: OpenSpanRow): void {
  const result = getMetricsDb().prepare(`
    UPDATE spans SET
      session_id = ?, provider = ?, model = ?, project_root = ?, origin = ?,
      user_id = ?, user_email = ?, organization_id = ?, attrs = ?
    WHERE span_id = ? AND ended_at IS NULL
  `).run(
    row.sessionId ?? null,
    row.provider ?? null,
    row.model ?? null,
    row.projectRoot ?? null,
    row.origin ?? null,
    row.userId ?? null,
    row.userEmail ?? null,
    row.organizationId ?? null,
    JSON.stringify(row.attrs ?? {}),
    row.spanId,
  )
  if (row.kind === SPAN_KINDS.turn && Number(result.changes) > 0) announceTurnRow(row, 'unknown')
}

function insertSpan(row: SpanRow): void {
  // A replace, not a plain insert: a turn's root may already be here as an
  // open row from `writeOpenSpan`, and the finished span is the record.
  getMetricsDb().prepare(`
    INSERT OR REPLACE INTO spans (
      span_id, parent_span_id, trace_id, kind, name, service,
      session_id, provider, model, project_root, origin,
      user_id, user_email, organization_id,
      started_at, ended_at, duration_ms, status, attrs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    row.userId ?? null,
    row.userEmail ?? null,
    row.organizationId ?? null,
    row.startedAt,
    row.endedAt,
    row.endedAt - row.startedAt,
    row.status,
    JSON.stringify(row.attrs ?? {}),
  )
}

/** Inserts one event and answers the `event_id` the table assigned it. */
function insertLogEvent(row: LogEventRow): number {
  const result = getMetricsDb().prepare(`
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
  return Number(result.lastInsertRowid)
}

/** Records one finished span. The record is append-only: a span arrives here
 *  once, when it ends. */
export function writeSpan(row: SpanRow): void {
  insertSpan(row)
}

/** Records one completed span and every structured log event it owns as one
 * transaction. A reader never observes an event without its span or a span
 * whose completed event set is only partly present. Answers the `event_id` of
 * each event, in the order given: the ids the mirror names them by. */
export function writeSpanRecord(row: SpanRow, events: LogEventRow[]): number[] {
  const db = getMetricsDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    insertSpan(row)
    const eventIds = events.map(insertLogEvent)
    db.exec('COMMIT')
    if (row.kind === SPAN_KINDS.turn) announceTurnRow(row, row.status)
    return eventIds
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Removes spans that began before the rollover cutoff, their events with
 *  them, and gives the freed pages back to the file system. */
export function rolloverSpans(cutoff: number): number {
  const db = getMetricsDb()
  // Counted first: a driver's change count may or may not include the events the delete cascades to.
  const rawRow: unknown = db.prepare('SELECT COUNT(*) AS count FROM spans WHERE started_at < ?').get(cutoff)
  // SAFETY: the aggregate statement always returns its single named row.
  const removed = Number((rawRow as { count: number }).count)
  if (removed === 0) return 0
  db.prepare('DELETE FROM spans WHERE started_at < ?').run(cutoff)
  db.exec('PRAGMA incremental_vacuum')
  return removed
}
