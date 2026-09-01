import type { MetricsQueryResult } from '@solus/contracts/observability-types'
import {
  asFiniteNumber,
  columnIndex,
  composeLabel,
  dimensionColumns,
  measureColumns,
  measureFormat,
  numericColumns,
  parseBucketLabel,
  TIME_BUCKET_COLUMNS,
} from './result-columns'
import { SERIES_COLOR_COUNT } from './span-palette'

// The two chart forms a result can be read as, derived from the answer alone.
//
// A **trend** has a time column: one measure over time, one line per value of
// the dimension the query grouped by. A **ranking** has none: one measure
// across a categorical dimension, in the order the query asked for.
//
// Both take an optional measure column, because a result carries several and
// the reader — not this file's preference order — has the last word on which
// one is the answer.
//
// Pure and non-reactive: the page reads these from `$derived`.

export interface TrendPoint {
  /** Epoch ms — parsed from the bucket label when the query grouped time. */
  at: number
  value: number
  failed: boolean
  /** The line this point belongs to, restated on the point so the tooltip and
   *  the highlight can name it from the flattened cloud. Empty when the result
   *  breaks down by nothing. */
  series: string
  /** The one row this point stands for, where it stands for one: its drill
   *  path. A bucketed aggregate is many rows, so it carries neither. */
  traceId?: string | null
  spanId?: string | null
}

/** One series: the rows sharing a value of the breakdown dimension. */
export interface TrendLine {
  /** The dimension value(s) this line stands for; empty when there is no
   *  breakdown and the whole result is one line. */
  label: string
  points: TrendPoint[]
  /** The runs of consecutive buckets, drawn as separate strokes. A bucket with
   *  no row is absent from a `GROUP BY`, and a stroke across it would state a
   *  continuity nobody measured. */
  segments: TrendPoint[][]
}

export interface Trend {
  timeColumn: string
  valueColumn: string
  valueFormat: 'duration' | 'number'
  /** Every measure the result carries, so the reader can chart another. */
  measures: string[]
  /** Raw instants draw as a scatter; bucketed aggregates connect as a line. */
  mark: 'points' | 'line'
  /** The column(s) the result breaks down by, named for the heading and the
   *  legend. Null when every row belongs to one series. */
  seriesColumn: string | null
  lines: TrendLine[]
  /** Series the palette had no hue for. Never silently dropped: the chart says
   *  how many are only in the table. */
  hiddenSeries: number
}

export interface RankingBar {
  label: string
  value: number
}

export interface Ranking {
  /** The dimension the bars name, for the heading. */
  dimensionColumn: string
  valueColumn: string
  valueFormat: 'duration' | 'number'
  measures: string[]
  bars: RankingBar[]
  /** Bars below the cut. Stated on the chart, never dropped in silence. */
  hiddenBars: number
}

/** How many series the categorical ramp has hues for. A generated seventh hue
 *  is not a colour anyone can name, so the extra series stay in the table. */
export const MAX_TREND_SERIES = SERIES_COLOR_COUNT

/** Bars past this are unreadable at the height a chart above a table can take,
 *  and the table below states every one of them anyway. */
export const MAX_RANKING_BARS = 12

/** The measure a chart draws: the reader's choice where they made one, else the
 *  first duration-like column, else the first numeric one. */
function chooseMeasure(
  result: MetricsQueryResult,
  candidates: number[],
  chosen: string | undefined,
): number {
  const picked = candidates.find((index) => result.columns[index].name === chosen)
  if (picked !== undefined) return picked
  return candidates.find((index) => result.columns[index].name.endsWith('_ms')) ?? candidates[0]
}

/**
 * How a result reads as a chart over time: one time column (raw `started_at`
 * instants, or a bucket label) against one measure, split into one line per
 * value of the breakdown dimension the query grouped by.
 *
 * The split is the point. `select day, model, sum(cost_usd) … group by day,
 * model` is two questions' worth of rows; one line through all of them connects
 * one model's Monday to another model's Tuesday and states a change nobody
 * measured. One measure, one axis; the others stay in the table, reachable
 * through `measures`.
 */
export function trendChart(
  result: MetricsQueryResult | null,
  measure?: string,
): Trend | null {
  if (!result || result.rows.length === 0) return null
  const epochIndex = columnIndex(result, 'started_at')
  const bucketIndex = result.columns.findIndex((column) => TIME_BUCKET_COLUMNS.has(column.name))
  const timeIndex = epochIndex !== -1 ? epochIndex : bucketIndex
  if (timeIndex === -1) return null
  const timeKind: 'epoch' | 'bucket' = epochIndex !== -1 ? 'epoch' : 'bucket'

  const numeric = numericColumns(result)
  const candidates = measureColumns(result, numeric, new Set([timeIndex]))
  if (candidates.length === 0) return null
  const valueIndex = chooseMeasure(result, candidates, measure)
  const valueColumn = result.columns[valueIndex].name

  const breakdown = dimensionColumns(result, numeric, new Set([timeIndex, valueIndex]))
  const statusIndex = columnIndex(result, 'status')
  const byLabel = new Map<string, TrendPoint[]>()
  for (const row of result.rows) {
    const at = timeKind === 'epoch' ? asFiniteNumber(row[timeIndex]) : parseBucketLabel(row[timeIndex])
    const measured = asFiniteNumber(row[valueIndex])
    if (at == null || measured == null) continue
    const status = statusIndex === -1 ? undefined : row[statusIndex]
    const label = composeLabel(row, breakdown)
    const points = byLabel.get(label) ?? []
    points.push({
      at,
      value: measured,
      failed: status === 'error' || status === 'interrupted',
      series: label,
    })
    byLabel.set(label, points)
  }
  if (byLabel.size === 0) return null

  const mark: 'points' | 'line' = timeKind === 'epoch' ? 'points' : 'line'
  // One value of the dimension is no breakdown at all — the whole answer is one
  // line, and a legend of one entry is furniture.
  //
  // Past the ramp's hues a scatter stays *unsplit* rather than losing its tail:
  // dropping observations is the one thing a cloud of observations must not do,
  // and a scatter connects nothing, so it never misstated the dimension the way
  // a line through mixed rows does. Only a line pays the hue cap.
  const split = byLabel.size > 1 && (mark === 'line' || byLabel.size <= SERIES_COLOR_COUNT)
  const byTime = (a: TrendPoint, b: TrendPoint): number => a.at - b.at
  const ranked = split
    ? [...byLabel.entries()]
      .map(([label, points]) => ({
        label,
        points: points.sort(byTime),
        total: points.reduce((sum, point) => sum + point.value, 0),
      }))
      // Biggest first decides which series the ramp can hold; the drawn ones
      // are then ordered by name, so a series keeps its hue as the window moves.
      .sort((a, b) => b.total - a.total)
    : [{
        label: '',
        points: [...byLabel.values()].flat()
          .map((point) => ({ ...point, series: '' }))
          .sort(byTime),
        total: 0,
      }]
  const drawn = ranked.slice(0, MAX_TREND_SERIES).sort((a, b) => a.label.localeCompare(b.label))

  const grain = mark === 'line' ? bucketGrain(result.columns[timeIndex].name, drawn) : null
  return {
    timeColumn: result.columns[timeIndex].name,
    valueColumn,
    valueFormat: measureFormat(valueColumn),
    measures: candidates.map((index) => result.columns[index].name),
    mark,
    seriesColumn: split ? breakdown.map((index) => result.columns[index].name).join(' · ') : null,
    lines: drawn.map(({ label, points }) => ({
      label,
      points,
      segments: lineSegments(points, grain),
    })),
    hiddenSeries: ranked.length - drawn.length,
  }
}

/**
 * How a result reads as a ranking: one measure across a categorical dimension,
 * with no time column to place it on.
 *
 * Most shipped presets are this shape — `select tool, count(*), sum(duration_ms)
 * … group by tool order by total_ms desc` — and a grid of numbers makes the
 * reader do the comparing that a bar length does for free.
 */
export function rankingChart(
  result: MetricsQueryResult | null,
  measure?: string,
): Ranking | null {
  if (!result || result.rows.length === 0) return null
  // A time column makes it a trend; this form is what is left over.
  if (result.columns.some(({ name }) => name === 'started_at' || TIME_BUCKET_COLUMNS.has(name))) {
    return null
  }

  const numeric = numericColumns(result)
  const candidates = measureColumns(result, numeric, new Set())
  if (candidates.length === 0) return null
  const dimensions = dimensionColumns(result, numeric, new Set(candidates))
  if (dimensions.length === 0) return null
  const valueIndex = chooseMeasure(result, candidates, measure ?? rankedMeasure(result, candidates))
  const valueColumn = result.columns[valueIndex].name

  const bars: RankingBar[] = []
  for (const row of result.rows) {
    const value = asFiniteNumber(row[valueIndex])
    if (value == null) continue
    bars.push({ label: composeLabel(row, dimensions), value })
  }
  if (bars.length < 2) return null

  // The query's own order is kept: `order by total_ms desc` is the reader's
  // ranking, and re-sorting by the drawn measure would answer a question they
  // did not ask. Only the cut is ours.
  return {
    dimensionColumn: dimensions.map((index) => result.columns[index].name).join(' · '),
    valueColumn,
    valueFormat: measureFormat(valueColumn),
    measures: candidates.map((index) => result.columns[index].name),
    bars: bars.slice(0, MAX_RANKING_BARS),
    hiddenBars: Math.max(0, bars.length - MAX_RANKING_BARS),
  }
}

/**
 * The measure the query ranked by, inferred from the order its rows arrived in:
 * `order by total_ms desc` hands back rows already monotonic in `total_ms`.
 *
 * The result carries no `ORDER BY`, so this is the only trace of what the
 * question was about — and it beats "first numeric column", which charts the
 * `count(*)` that happens to be selected first.
 *
 * Several columns can be monotonic at once (a tool ranked by total time is
 * often ranked by its average too), and every one of them is consistent with
 * the order. The last wins, because a query lists the measure it ranks by last
 * — `select tool, count(*) as calls, avg(…), sum(…) as total_ms … order by
 * total_ms desc`. It is a reading of intent, not a fact, which is why the
 * heading names the measure it chose and offers the others.
 */
function rankedMeasure(result: MetricsQueryResult, candidates: number[]): string | undefined {
  const monotonic = candidates.filter((index) => {
    const values = result.rows
      .map((row) => asFiniteNumber(row[index]))
      .filter((value): value is number => value != null)
    if (values.length < 3) return false
    return values.every((value, at) => at === 0 || value <= values[at - 1])
      || values.every((value, at) => at === 0 || value >= values[at - 1])
  })
  return monotonic.length === 0 ? undefined : result.columns[monotonic[monotonic.length - 1]].name
}

/** Two observations are the fewest that can show a change, and a line needs
 *  two points in the same series to be drawn at all. Anything less is a number,
 *  and the table already states it. */
export function isReadableTrend(trend: Trend): boolean {
  const total = trend.lines.reduce((sum, line) => sum + line.points.length, 0)
  if (total < 2) return false
  return trend.mark === 'points' || trend.lines.some((line) => line.points.length >= 2)
}

// ── Where a line breaks ──

type NamedGrain = 'minute' | 'hour' | 'day' | 'week' | 'month'

/** A bucket step, however it was learned: the grain the column names, or the
 *  spacing the points themselves show. */
type BucketGrain = { named: NamedGrain } | { ms: number }

/** The bucket a column name declares. `date` is the compiler's day bucket under
 *  another alias; `bucket` names no width, so it is inferred from the points. */
const GRAIN_BY_COLUMN = new Map<string, NamedGrain>([
  ['minute', 'minute'],
  ['hour', 'hour'],
  ['day', 'day'],
  ['date', 'day'],
  ['week', 'week'],
  ['month', 'month'],
])

/**
 * How wide one bucket is — the step a missing row would have occupied.
 *
 * The column name is authoritative where the compiler wrote it (`day`, `hour`,
 * …), because a calendar step is not a constant: a month is 28 to 31 days, and
 * a day across a DST change is 23 or 25 hours. A query that aliased its bucket
 * (`… as bucket`) leaves only the data, so the step is the most common gap
 * between consecutive points — which needs three of them to mean anything.
 */
function bucketGrain(timeColumn: string, lines: { points: TrendPoint[] }[]): BucketGrain | null {
  const named = GRAIN_BY_COLUMN.get(timeColumn)
  if (named !== undefined) return { named }

  const instants = [...new Set(lines.flatMap((line) => line.points.map((point) => point.at)))]
    .sort((a, b) => a - b)
  if (instants.length < 3) return null
  const counts = new Map<number, number>()
  for (let at = 1; at < instants.length; at += 1) {
    const step = instants[at] - instants[at - 1]
    counts.set(step, (counts.get(step) ?? 0) + 1)
  }
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
  return modal ? { ms: modal[0] } : null
}

/** The instant the bucket after this one starts, by the calendar rather than by
 *  arithmetic — so a month step lands on the first, and a DST day is still one
 *  day. */
function nextBucketStart(at: number, grain: BucketGrain): number {
  if ('ms' in grain) return at + grain.ms
  const next = new Date(at)
  if (grain.named === 'minute') next.setMinutes(next.getMinutes() + 1)
  else if (grain.named === 'hour') next.setHours(next.getHours() + 1)
  else if (grain.named === 'day') next.setDate(next.getDate() + 1)
  else if (grain.named === 'week') next.setDate(next.getDate() + 7)
  else next.setMonth(next.getMonth() + 1)
  return next.getTime()
}

/**
 * A line's points split into runs of consecutive buckets.
 *
 * A `GROUP BY` returns no row for a bucket nothing happened in, so a stroke
 * from one side of the hole to the other draws a continuity nobody measured.
 * The line is broken there instead. Filling the hole with zero would be a
 * different claim — right for a `count`, wrong for an average or a percentile —
 * and this cannot tell which it is holding.
 *
 * An inferred step is compared with slack, because "the most common gap" is a
 * measurement, not a promise; a named grain is exact.
 */
export function lineSegments(points: TrendPoint[], grain: BucketGrain | null): TrendPoint[][] {
  if (grain === null || points.length < 2) return [points]
  const slack = 'ms' in grain ? 1.5 : 1
  const segments: TrendPoint[][] = [[points[0]]]
  for (let at = 1; at < points.length; at += 1) {
    const gapStartsAfter = nextBucketStart(points[at - 1].at, grain)
    const tolerated = points[at - 1].at + (gapStartsAfter - points[at - 1].at) * slack
    if (points[at].at > tolerated) segments.push([points[at]])
    else segments[segments.length - 1].push(points[at])
  }
  return segments
}
