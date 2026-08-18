import type {
  MetricsQueryResult,
  MetricsSchema,
  MetricsValue,
} from '../../../../shared/observability-types'
import {
  isReadableTrend,
  rankingChart,
  trendChart,
  type Ranking,
  type Trend,
} from './chart-shape'
import {
  asFiniteNumber,
  asStringOrNull,
  numericColumns,
} from './result-columns'
import { isTurnResult } from './turn-rows'
import { isFailedStatus, type TimeSelection, type VolumePoint } from './volume'

// Result shape → which rendering answers the query (docs/plans/observability.md).
//
// The server declares the grain (`sourceView`); this module maps it to one of
// the five locked shapes: a turn listing, an event listing (span-grained rows
// that link into their turn's waterfall), a trend (a measure over time), a
// ranking (a measure across a categorical dimension), or the plain grid.
// Detection starts from the declared grain and only falls back to column
// heuristics where no grain was declared — a span listing must never
// masquerade as turns again.
//
// The chart forms themselves live in `chart-shape.ts`; this file decides which
// one the answer is, not how it is drawn.
//
// Pure and non-reactive: the page reads these from `$derived`.

export type ResultShape =
  | { shape: 'turns' }
  | { shape: 'events'; view: string; kind: string }
  | { shape: 'trend'; trend: Trend }
  | { shape: 'ranking'; ranking: Ranking }
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

/** Identity and payload columns a query carries for linking, not for reading.
 *  They stay in the result; the event table just does not render them. */
const EVENT_HIDDEN_COLUMNS = new Set(['span_id', 'trace_id', 'parent_span_id', 'attrs'])

/** The measure a chart draws, where the reader picked one. A result that does
 *  not carry that column ignores it and falls back to its own preference. */
export type ChartMeasure = string | undefined

export function resultShape(
  result: MetricsQueryResult | null,
  schema: MetricsSchema | null,
  measure?: ChartMeasure,
): ResultShape {
  if (!result) return { shape: 'table' }
  if (isTurnResult(result)) return { shape: 'turns' }
  const view = result.sourceView
  if (view !== undefined && view !== 'turns' && result.columns.includes('started_at')) {
    return { shape: 'events', view, kind: eventKind(result, schema, view) }
  }
  const trend = trendChart(result, measure)
  if (trend && isReadableTrend(trend)) return { shape: 'trend', trend }
  const ranking = rankingChart(result, measure)
  if (ranking) return { shape: 'ranking', ranking }
  return { shape: 'table' }
}

/** What kind of event the listing shows, for its title and hue. The `events`
 *  view holds many kinds, so the answer itself decides: a selected `kind`
 *  column with one distinct value names it; failing that, a single-kind view
 *  does; a mixed or unknowable listing stays generic. */
function eventKind(
  result: MetricsQueryResult,
  schema: MetricsSchema | null,
  view: string,
): string {
  const kindIndex = result.columns.indexOf('kind')
  if (kindIndex !== -1) {
    const distinct = new Set(
      result.rows
        .map((row) => row[kindIndex])
        .filter((value): value is string => typeof value === 'string' && value !== ''),
    )
    if (distinct.size === 1) return [...distinct][0]
    if (distinct.size > 1) return ''
  }
  const kinds = schema?.views.find((candidate) => candidate.view === view)?.kinds
  return kinds?.length === 1 ? kinds[0] : ''
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

  // A `kind` column with one distinct value is the listing's title, not a cell
  // worth a column of identical strings; a mixed listing keeps it visible.
  const kindIndex = result.columns.indexOf('kind')
  const kindValues = new Set(kindIndex === -1 ? [] : result.rows.map((row) => row[kindIndex]))
  const displayNames = result.columns.filter(
    (name) => !EVENT_HIDDEN_COLUMNS.has(name) && (name !== 'kind' || kindValues.size > 1),
  )
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

/** Event rows as the histogram counts them — one bar per span, failures drawn
 *  from the same baseline, exactly as turns are counted. */
export function eventPoints(rows: EventRow[]): VolumePoint[] {
  return rows.map((row) => ({
    at: row.startedAt,
    failed: isFailedStatus(row.status),
    // A span records no cost; only its enclosing turn does.
    costUsd: null,
    durationMs: row.durationMs,
  }))
}

/** The histogram's brush narrows event rows the same way it narrows turns. */
export function eventsWithinSelection(rows: EventRow[], selection: TimeSelection | null): EventRow[] {
  if (!selection) return rows
  return rows.filter((row) => row.startedAt >= selection.from && row.startedAt < selection.to)
}
