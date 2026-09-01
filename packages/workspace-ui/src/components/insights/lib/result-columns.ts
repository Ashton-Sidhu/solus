import type { MetricsQueryResult, MetricsResultColumn, MetricsValue } from '@solus/contracts/observability-types'

// What a result's columns are.
//
// A column the registry declares arrives typed, and that declaration is what
// the chart shapes and the event table read. Only a column the query invented —
// an aliased aggregate, a computed expression — has no declaration, and only
// those are classified by reading their cells. The chart shapes and the event
// table share these, which is why they live below both rather than inside
// either.
//
// Pure and non-reactive.

/** Aliases the QuerySpec compiler and the NL examples give bucketed time. */
export const TIME_BUCKET_COLUMNS = new Set([
  'bucket', 'day', 'date', 'hour', 'minute', 'week', 'month',
])

/** Neither a measure nor a dimension: `status` is a state that failures already
 *  wear a reserved colour for, and `attrs` is a payload. */
const NEVER_DIMENSION_COLUMNS = new Set(['status', 'attrs'])

// A cell arrives as `MetricsValue`, a SQL value that has not been read yet. The
// four decoders below are that boundary — every other module in the feature
// branches on what they return, never on the cell's representation.

/** The JS class tag of a cell, read once here so nothing else has to. */
function cellTag(value: MetricsValue | undefined): string {
  return Object.prototype.toString.call(value)
}

export function asFiniteNumber(value: MetricsValue | undefined): number | null {
  return cellTag(value) === '[object Number]' && Number.isFinite(value) ? Number(value) : null
}

export function asStringOrNull(value: MetricsValue | undefined): string | null {
  return cellTag(value) === '[object String]' && value ? String(value) : null
}

/** True when the cell holds a number — including one a chart cannot measure,
 *  which is what makes a whole column numeric. */
export function isNumberCell(value: MetricsValue | undefined): boolean {
  return cellTag(value) === '[object Number]'
}

/** How one cell prints in a grid: an em dash for a missing value, integers
 *  exact, fractions to three places, anything else as itself. */
export function displayCell(value: MetricsValue): string {
  if (value == null) return '—'
  const numeric = asFiniteNumber(value)
  if (numeric !== null) return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(3)
  return String(value)
}

/** True when the cell holds a non-empty string a chart can group by. */
export function isTextCell(value: MetricsValue | undefined): boolean {
  return asStringOrNull(value) !== null
}

/** Index of a named column in a result, or -1. */
export function columnIndex(result: MetricsQueryResult, name: string): number {
  return result.columns.findIndex((column) => column.name === name)
}

/** True when the registry declares this column as a quantity. */
function isDeclaredNumeric(column: MetricsResultColumn): boolean {
  return column.type === 'number' || column.type === 'duration'
}

/** Which columns hold numbers. A declared column answers from its own type; an
 *  invented one is classified by reading every cell, which is why a result of
 *  aliased aggregates costs more to render than a plain view listing. */
export function numericColumns(result: MetricsQueryResult): boolean[] {
  return result.columns.map((column, index) => {
    if (column.type !== undefined) return isDeclaredNumeric(column)
    return result.rows.some((row) => row[index] != null)
      && result.rows.every((row) => row[index] == null || isNumberCell(row[index]))
  })
}

/** A column a chart may measure: a number that means a quantity, never an id
 *  and never a time in numeric clothing. */
export function measureColumns(
  result: MetricsQueryResult,
  numeric: boolean[],
  taken: Set<number>,
): number[] {
  return result.columns
    .map((column, index) => ({ name: column.name, index }))
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
    .map((column, index) => ({ name: column.name, index }))
    .filter(({ name, index }) =>
      !taken.has(index)
      && !numeric[index]
      && !name.endsWith('_id')
      && !NEVER_DIMENSION_COLUMNS.has(name)
      && !TIME_BUCKET_COLUMNS.has(name)
      // A declared string column still needs a label in it: a column of nulls
      // groups nothing.
      && result.rows.some((row) => isTextCell(row[index])))
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
  const label = asStringOrNull(value)
  if (label === null) return null
  const parts = BUCKET_LABEL.exec(label)
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
