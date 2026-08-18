import type { MetricsQueryResult, MetricsValue } from '../../../../shared/observability-types'

// What a result's columns are, read off the answer itself.
//
// SQL can alias anything, so nothing here trusts a name it does not have to:
// a column is numeric because every row's value is, categorical because some
// row holds a string. The chart shapes and the event table share these, which
// is why they live below both rather than inside either.
//
// Pure and non-reactive.

/** Aliases the QuerySpec compiler and the NL examples give bucketed time. */
export const TIME_BUCKET_COLUMNS = new Set([
  'bucket', 'day', 'date', 'hour', 'minute', 'week', 'month',
])

/** Neither a measure nor a dimension: `status` is a state that failures already
 *  wear a reserved colour for, and `attrs` is a payload. */
const NEVER_DIMENSION_COLUMNS = new Set(['status', 'attrs'])

export function asFiniteNumber(value: MetricsValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asStringOrNull(value: MetricsValue | undefined): string | null {
  return typeof value === 'string' && value ? value : null
}

export function numericColumns(result: MetricsQueryResult): boolean[] {
  return result.columns.map((_, index) =>
    result.rows.some((row) => row[index] != null) &&
    result.rows.every((row) => row[index] == null || typeof row[index] === 'number'))
}

/** A column a chart may measure: a number that means a quantity, never an id
 *  and never a time in numeric clothing. */
export function measureColumns(
  result: MetricsQueryResult,
  numeric: boolean[],
  taken: Set<number>,
): number[] {
  return result.columns
    .map((name, index) => ({ name, index }))
    .filter(({ name, index }) =>
      !taken.has(index)
      && numeric[index]
      && !name.endsWith('_id')
      && name !== 'started_at'
      && name !== 'ended_at'
      && !TIME_BUCKET_COLUMNS.has(name))
    .map(({ index }) => index)
}

/** The columns a `GROUP BY` left beside the measures — the dimension the answer
 *  is really about. Categorical only: a measure is a number, and an id names a
 *  row rather than a group. */
export function dimensionColumns(
  result: MetricsQueryResult,
  numeric: boolean[],
  taken: Set<number>,
): number[] {
  return result.columns
    .map((name, index) => ({ name, index }))
    .filter(({ name, index }) =>
      !taken.has(index)
      && !numeric[index]
      && !name.endsWith('_id')
      && !NEVER_DIMENSION_COLUMNS.has(name)
      && !TIME_BUCKET_COLUMNS.has(name)
      && result.rows.some((row) => typeof row[index] === 'string' && row[index] !== ''))
    .map(({ index }) => index)
}

/** All dimension columns compose one key. Splitting by one of two dimensions
 *  would group rows that differ in the other. */
export function composeLabel(row: MetricsValue[], indexes: number[]): string {
  return indexes.map((index) => String(row[index] ?? '—')).join(' · ')
}

/** A duration column reads as `3m04`, everything else as a plain number. The
 *  registry types event columns, but an aggregate is whatever SQL aliased it,
 *  so the suffix is all there is to go on. */
export function measureFormat(name: string): 'duration' | 'number' {
  return name.endsWith('_ms') ? 'duration' : 'number'
}

/**
 * Bucket labels are ISO-ish strings (`2026-08-16`, `2026-08-16T14:00`,
 * `2026-08`); anything that is not one drops the row from the chart.
 *
 * They are **wall-clock labels, not instants**, so they are read as local time
 * — which is what puts a point under the tick bearing its own name. `Date.parse`
 * cannot be used directly: it reads a date-only string as UTC and a date-time
 * string as local, so a `day` bucket landed on the previous evening's tick
 * while an `hour` bucket landed where its label said. (The buckets themselves
 * are cut in UTC by the compiler — whether a "day" should mean the reader's day
 * is a question for the SQL, not for the axis.)
 */
const BUCKET_LABEL = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2}))?$/

export function parseBucketLabel(value: MetricsValue | undefined): number | null {
  if (typeof value !== 'string' || !value) return null
  const parts = BUCKET_LABEL.exec(value)
  if (!parts) return null
  const [, year, month, day, hour, minute] = parts
  const at = {
    year: Number(year),
    month: Number(month),
    day: day === undefined ? 1 : Number(day),
    hour: hour === undefined ? 0 : Number(hour),
    minute: minute === undefined ? 0 : Number(minute),
  }
  // `2026-33` is a `%Y-%W` week number, not a month. It matches the shape of a
  // month bucket, and `new Date` would roll it forward two years rather than
  // reject it — a row placed two years from its own label is worse than a row
  // the chart admits it cannot place.
  if (at.month < 1 || at.month > 12 || at.day < 1 || at.day > 31) return null
  if (at.hour > 23 || at.minute > 59) return null
  const epoch = new Date(at.year, at.month - 1, at.day, at.hour, at.minute).getTime()
  return Number.isFinite(epoch) ? epoch : null
}
