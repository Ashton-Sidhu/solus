import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
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
import { storeTurnMeasures } from './turn-measures'

const log = createLogger('SpanTable', 'span-table.ts')

// ─── The `spans` table ───
//
// One row per finished span, and the only two things anybody does to it: write
// a span when it ends, and drop spans older than the retention window.
//
// Every id and timestamp is required, because every one of them is decided
// before a row gets here — the tracer mints the ids, and Solus decides the
// times a span covers. Nothing invents either at the table.
//
// A span arrives with one flat attribute bag. This table owns how that bag is
// stored: the long texts (`SPAN_TEXT_NAMES`) become `span_texts` rows and the
// rest is the `attrs` JSON, so an aggregate over `spans` never reads a body
// (plans/029 §6). A reader that needs the texts joins them back (`rollups.ts`).

/** The attribute names whose values are long texts: a turn's prompt, system
 *  prompt, and response, and a thinking span's thought. Stored as `span_texts`
 *  rows, never as keys of `attrs`. */
export const SPAN_TEXT_NAMES = ['prompt', 'systemPrompt', 'response', 'thought'] as const
export type SpanTextName = (typeof SPAN_TEXT_NAMES)[number]

const spanTextNames: ReadonlySet<string> = new Set(SPAN_TEXT_NAMES)

export function isSpanTextName(name: string): name is SpanTextName {
  return spanTextNames.has(name)
}

/** One span's attribute bag as the table stores it. */
export interface StoredSpanAttributes {
  /** Every attribute but the texts, as the `attrs` JSON holds it. */
  attrs: SpanAttributes
  /** The texts, as `span_texts` rows. An empty text is no row. */
  texts: Array<{ name: SpanTextName; text: string }>
}

/** A text is a non-empty string; a text attribute of any other shape is dropped. */
const spanTextSchema = z.string().min(1)

export function splitSpanTexts(attributes: SpanAttributes | undefined): StoredSpanAttributes {
  const attrs: SpanAttributes = {}
  const texts: StoredSpanAttributes['texts'] = []
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (isSpanTextName(name)) {
      const text = spanTextSchema.safeParse(value)
      if (text.success) texts.push({ name, text: text.data })
      continue
    }
    attrs[name] = value
  }
  return { attrs, texts }
}

/** Writes a span's texts. Inside the caller's transaction. */
export function upsertSpanTexts(db: DatabaseSync, spanId: string, texts: StoredSpanAttributes['texts']): void {
  if (texts.length === 0) return
  const upsert = db.prepare(`
    INSERT INTO span_texts (span_id, name, text) VALUES (?, ?, ?)
    ON CONFLICT (span_id, name) DO UPDATE SET text = excluded.text
  `)
  for (const { name, text } of texts) upsert.run(spanId, name, text)
}

/** One write and what follows it, as one transaction on the metrics file. */
export function metricsTransaction<Result>(db: DatabaseSync, write: () => Result): Result {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = write()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

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
 * happens. The finished span takes over this row when it ends (`insertSpan`
 * updates on the same key), and a row that already exists is left alone: an
 * end that raced the start must not be overwritten by the start.
 */
export function writeOpenSpan(row: OpenSpanRow): void {
  const db = getMetricsDb()
  const stored = splitSpanTexts(row.attrs)
  const changed = metricsTransaction(db, () => {
    const result = db.prepare(`
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
      JSON.stringify(stored.attrs),
    )
    // An ignored insert changed nothing: the finished row is already there,
    // and its texts are the record.
    const inserted = Number(result.changes) > 0
    if (inserted) upsertSpanTexts(db, row.spanId, stored.texts)
    return inserted
  })
  if (row.kind === SPAN_KINDS.turn && changed) announceTurnRow(row, 'unknown')
}

/**
 * Rewrites a running span's open row with what it learned since it started —
 * the executed model, the task it runs under. Only a row that is still open is
 * touched: once the finished span is written, it is the record.
 */
export function updateOpenSpan(row: OpenSpanRow): void {
  const db = getMetricsDb()
  const stored = splitSpanTexts(row.attrs)
  const changed = metricsTransaction(db, () => {
    const result = db.prepare(`
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
      JSON.stringify(stored.attrs),
      row.spanId,
    )
    const updated = Number(result.changes) > 0
    if (updated) upsertSpanTexts(db, row.spanId, stored.texts)
    return updated
  })
  if (row.kind === SPAN_KINDS.turn && changed) announceTurnRow(row, 'unknown')
}

/** The columns a finished span sets; `excluded.<column>` on a conflict. */
const SPAN_WRITE_COLUMNS = [
  'parent_span_id', 'trace_id', 'kind', 'name', 'service',
  'session_id', 'provider', 'model', 'project_root', 'origin',
  'user_id', 'user_email', 'organization_id',
  'started_at', 'ended_at', 'duration_ms', 'status', 'attrs',
] as const

/**
 * The finished span's write. An update on conflict, not a replace: a turn's
 * root may already be here as an open row from `writeOpenSpan`, and a replace
 * would delete that row and cascade away its texts and events (plans/028 E6).
 */
const INSERT_SPAN_SQL = `
  INSERT INTO spans (span_id, ${SPAN_WRITE_COLUMNS.join(', ')})
  VALUES (?, ${SPAN_WRITE_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT (span_id) DO UPDATE SET
    ${SPAN_WRITE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ')}
`

/** Writes one finished span, its texts, and — when its trace's root has ended —
 *  the root's measures. Inside the caller's transaction. */
function insertSpan(db: DatabaseSync, row: SpanRow): void {
  const stored = splitSpanTexts(row.attrs)
  db.prepare(INSERT_SPAN_SQL).run(
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
    JSON.stringify(stored.attrs),
  )
  upsertSpanTexts(db, row.spanId, stored.texts)
  storeTurnMeasures(db, row.traceId)
}

/** Inserts one event and answers the `event_id` the table assigned it. */
function insertLogEvent(db: DatabaseSync, row: LogEventRow): number {
  const result = db.prepare(`
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
  const db = getMetricsDb()
  metricsTransaction(db, () => insertSpan(db, row))
}

/** Records one completed span and every structured log event it owns as one
 * transaction. A reader never observes an event without its span or a span
 * whose completed event set is only partly present. Answers the `event_id` of
 * each event, in the order given: the ids the mirror names them by. */
export function writeSpanRecord(row: SpanRow, events: LogEventRow[]): number[] {
  const db = getMetricsDb()
  const eventIds = metricsTransaction(db, () => {
    insertSpan(db, row)
    return events.map((event) => insertLogEvent(db, event))
  })
  if (row.kind === SPAN_KINDS.turn) announceTurnRow(row, row.status)
  return eventIds
}

/** Removes spans that began before the rollover cutoff, their texts and
 *  events with them, and gives the freed pages back to the file system. */
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
