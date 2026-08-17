import type {
  MetricsQueryResult,
  MetricsSchema,
  MetricsValue,
} from '../../../../shared/observability-types'
import { isTurnResult } from './turn-rows'
import type { TimeSelection } from './volume'

// Result shape → which rendering answers the query (docs/plans/observability.md).
//
// The server declares the grain (`sourceView`); this module maps it to one of
// the four locked shapes: a turn listing, an event listing (span-grained rows
// that link into their turn's waterfall), a trend (a time column plus one
// numeric series), or the plain rollup grid. Detection starts from the declared
// grain and only falls back to column heuristics where no grain was declared —
// a span listing must never masquerade as turns again.
//
// Pure and non-reactive: the page reads these from `$derived`.

export type ResultShape =
  | { shape: 'turns' }
  | { shape: 'events'; view: string; kind: string }
  | { shape: 'trend'; series: TrendSeries }
  | { shape: 'table' }

/** How one event-table cell renders. */
export type CellFormat = 'time' | 'duration' | 'status' | 'raw'

export interface EventColumn {
  name: string
  format: CellFormat
  /** Right-aligned tabular numbers, inferred from the data like the plain grid
   *  does — SQL can alias anything. */
  numeric: boolean
}

export interface EventRow {
  startedAt: number
  durationMs: number | null
  status: string | null
  /** Link data for the waterfall deep link; rows without a trace stay plain. */
  traceId: string | null
  spanId: string | null
  /** Cells aligned to the event table's display columns. */
  cells: MetricsValue[]
}

export interface EventTable {
  columns: EventColumn[]
  rows: EventRow[]
  /** True when at least one row can open its turn's waterfall. */
  linkable: boolean
}

export interface TrendPoint {
  /** Epoch ms — parsed from the bucket label when the query grouped time. */
  at: number
  value: number
  failed: boolean
}

export interface TrendSeries {
  timeColumn: string
  valueColumn: string
  valueFormat: 'duration' | 'number'
  /** Raw instants draw as a scatter; bucketed aggregates connect as a line. */
  mark: 'points' | 'line'
  points: TrendPoint[]
}

/** Identity and payload columns a query carries for linking, not for reading.
 *  They stay in the result; the event table just does not render them. */
const EVENT_HIDDEN_COLUMNS = new Set(['span_id', 'trace_id', 'parent_span_id', 'attrs'])

/** Aliases the QuerySpec compiler and the NL examples give bucketed time. */
const TIME_BUCKET_COLUMNS = new Set(['bucket', 'day', 'date', 'hour', 'minute', 'week', 'month'])

export function resultShape(
  result: MetricsQueryResult | null,
  schema: MetricsSchema | null,
): ResultShape {
  if (!result) return { shape: 'table' }
  if (isTurnResult(result)) return { shape: 'turns' }
  const view = result.sourceView
  if (view !== undefined && view !== 'turns' && result.columns.includes('started_at')) {
    const descriptor = schema?.views.find((candidate) => candidate.view === view)
    return { shape: 'events', view, kind: descriptor?.kind ?? '' }
  }
  const series = trendSeries(result)
  if (series && series.points.length >= 2) return { shape: 'trend', series }
  return { shape: 'table' }
}

function asFiniteNumber(value: MetricsValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringOrNull(value: MetricsValue | undefined): string | null {
  return typeof value === 'string' && value ? value : null
}

/** Bucket labels are ISO-ish strings (`2026-08-16`, `2026-08-16T14:00`,
 *  `2026-08`); anything Date can't parse drops the row from the series. */
function parseBucketLabel(value: MetricsValue | undefined): number | null {
  if (typeof value !== 'string' || !value) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

function numericColumns(result: MetricsQueryResult): boolean[] {
  return result.columns.map((_, index) =>
    result.rows.some((row) => row[index] != null) &&
    result.rows.every((row) => row[index] == null || typeof row[index] === 'number'))
}

/** A column the trend may chart: a measure, never an id or a second time. */
function isTrendValueColumn(name: string): boolean {
  return !name.endsWith('_id')
    && name !== 'started_at'
    && name !== 'ended_at'
    && !TIME_BUCKET_COLUMNS.has(name)
}

/**
 * The single series a result can be read as: one time column (raw `started_at`
 * instants, or a bucket label) against the first duration-like — else first
 * numeric — measure. One series, one axis; further measures stay in the table.
 */
export function trendSeries(result: MetricsQueryResult | null): TrendSeries | null {
  if (!result || result.rows.length === 0) return null
  const epochIndex = result.columns.indexOf('started_at')
  const bucketIndex = result.columns.findIndex((name) => TIME_BUCKET_COLUMNS.has(name))
  const timeIndex = epochIndex !== -1 ? epochIndex : bucketIndex
  if (timeIndex === -1) return null
  const timeKind: 'epoch' | 'bucket' = epochIndex !== -1 ? 'epoch' : 'bucket'

  const numeric = numericColumns(result)
  const candidates = result.columns
    .map((name, index) => ({ name, index }))
    .filter(({ name, index }) => index !== timeIndex && numeric[index] && isTrendValueColumn(name))
  if (candidates.length === 0) return null
  const value = candidates.find(({ name }) => name.endsWith('_ms')) ?? candidates[0]

  const statusIndex = result.columns.indexOf('status')
  const points: TrendPoint[] = []
  for (const row of result.rows) {
    const at = timeKind === 'epoch' ? asFiniteNumber(row[timeIndex]) : parseBucketLabel(row[timeIndex])
    const measured = asFiniteNumber(row[value.index])
    if (at == null || measured == null) continue
    const status = statusIndex === -1 ? undefined : row[statusIndex]
    points.push({ at, value: measured, failed: status === 'error' || status === 'interrupted' })
  }
  if (points.length === 0) return null
  points.sort((a, b) => a.at - b.at)
  return {
    timeColumn: result.columns[timeIndex],
    valueColumn: value.name,
    valueFormat: value.name.endsWith('_ms') ? 'duration' : 'number',
    mark: timeKind === 'epoch' ? 'points' : 'line',
    points,
  }
}

function columnFormat(
  name: string,
  registeredType: string | undefined,
): CellFormat {
  if (name === 'started_at' || name === 'ended_at') return 'time'
  if (name === 'status') return 'status'
  if (registeredType === 'duration' || name.endsWith('_ms')) return 'duration'
  return 'raw'
}

/** An event-grain result as the event table renders it: display columns with
 *  their formats, and rows carrying the link identity the hidden columns hold.
 *  Rows without a usable start time are dropped — they cannot be placed. */
export function toEventTable(
  result: MetricsQueryResult,
  schema: MetricsSchema | null,
  view: string,
): EventTable {
  const registeredTypes = new Map(
    (schema?.views.find((candidate) => candidate.view === view)?.columns ?? [])
      .map((column) => [column.name, column.type]),
  )
  const index = new Map(result.columns.map((column, at) => [column, at]))
  const cell = (row: MetricsValue[], column: string): MetricsValue | undefined => {
    const at = index.get(column)
    return at === undefined ? undefined : row[at]
  }

  const displayNames = result.columns.filter((name) => !EVENT_HIDDEN_COLUMNS.has(name))
  const numeric = numericColumns(result)
  const columns: EventColumn[] = displayNames.map((name) => ({
    name,
    format: columnFormat(name, registeredTypes.get(name)),
    numeric: numeric[index.get(name) ?? -1] === true,
  }))

  const rows: EventRow[] = []
  for (const row of result.rows) {
    const startedAt = asFiniteNumber(cell(row, 'started_at'))
    if (startedAt == null) continue
    rows.push({
      startedAt,
      durationMs: asFiniteNumber(cell(row, 'duration_ms')),
      status: asStringOrNull(cell(row, 'status')),
      traceId: asStringOrNull(cell(row, 'trace_id')),
      spanId: asStringOrNull(cell(row, 'span_id')),
      cells: displayNames.map((name) => cell(row, name) ?? null),
    })
  }
  return {
    columns,
    rows,
    linkable: rows.some((row) => row.traceId != null),
  }
}

export interface EventStats {
  events: number
  failed: number
  failureRate: number
  p50DurationMs: number | null
  p95DurationMs: number | null
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

export function eventStats(rows: EventRow[]): EventStats {
  const failed = rows.filter((row) => row.status === 'error' || row.status === 'interrupted').length
  const durations = rows
    .map((row) => row.durationMs)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)
  return {
    events: rows.length,
    failed,
    failureRate: rows.length ? failed / rows.length : 0,
    p50DurationMs: durations.length ? percentile(durations, 0.5) : null,
    // Matches the turn list's rule: too few durations make a p95 meaningless.
    p95DurationMs: durations.length >= 4 ? percentile(durations, 0.95) : null,
  }
}

/** The histogram's brush narrows event rows the same way it narrows turns. */
export function eventsWithinSelection(rows: EventRow[], selection: TimeSelection | null): EventRow[] {
  if (!selection) return rows
  return rows.filter((row) => row.startedAt >= selection.from && row.startedAt < selection.to)
}
