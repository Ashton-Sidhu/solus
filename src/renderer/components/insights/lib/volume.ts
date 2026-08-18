import type { TurnRow } from './turn-rows'

// The volume histogram and the brush that narrows the list.
//
// The histogram counts whatever the answer lists: turns for a turn listing,
// spans for an event listing. Both reduce to the same currency — a `VolumePoint`
// is one row placed at an instant — so the chart, the stat line, and the brush
// never need to know which shape produced them. Brushing selects a time range;
// the list then filters to it. Pure and non-reactive.

/** Buckets across the window when the plot has not been measured yet. 48 over
 *  24 hours is one bar per half hour — fine enough to show a spike, coarse
 *  enough that a bar is still clickable. */
export const VOLUME_BUCKETS = 48

/**
 * How wide one bar's slot should be, in CSS pixels.
 *
 * A fixed bucket count makes bar width a function of the window's width: the
 * same 48 bars are hairlines in a drawer and 33px slabs across a wide desktop,
 * which is the whole reason a histogram can read as a bar chart of nothing.
 * Deriving the count from the width instead pins the bar to one size
 * everywhere, and the extra buckets a wide plot earns are extra resolution
 * rather than extra ink.
 */
const BUCKET_SLOT_PX = 21

/** Below this, bars are too thin to hover or brush; above it, the histogram is
 *  finer than the eye resolves and the tooltip covers several bars at once. */
const BUCKET_RANGE = { min: 16, max: 112 }

export function bucketCountForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return VOLUME_BUCKETS
  const slots = Math.round(width / BUCKET_SLOT_PX)
  return Math.min(BUCKET_RANGE.max, Math.max(BUCKET_RANGE.min, slots))
}

/** One counted row: an instant, whether it failed, and the measures the stat
 *  line summarises. A shape that records neither leaves them null. */
export interface VolumePoint {
  at: number
  failed: boolean
  costUsd: number | null
  durationMs: number | null
}

export interface VolumeBucket {
  /** Bucket start, epoch ms — the x value and the brush's domain unit. */
  at: number
  endAt: number
  total: number
  failed: number
}

export interface TimeSelection {
  from: number
  /** Exclusive, so adjacent buckets never double-count a turn. */
  to: number
}

export interface VolumeViewport {
  from: number
  to: number
}

/** The plot follows the active brush while the query window remains unchanged.
 * An invalid or stale selection falls back to the full plot instead of making
 * the chart disappear. */
export function volumeViewport(
  from: number,
  to: number,
  selection: TimeSelection | null,
): VolumeViewport {
  if (!selection) return { from, to }
  const selectedFrom = Math.max(from, selection.from)
  const selectedTo = Math.min(to, selection.to)
  return selectedTo > selectedFrom ? { from: selectedFrom, to: selectedTo } : { from, to }
}

export function isFailedStatus(status: string | null): boolean {
  return status === 'error' || status === 'interrupted'
}

export function turnPoints(rows: TurnRow[]): VolumePoint[] {
  return rows.map((row) => ({
    at: row.startedAt,
    failed: isFailedStatus(row.status),
    costUsd: row.costUsd,
    durationMs: row.durationMs,
  }))
}

/**
 * The window the points themselves occupy, or null when there are none. The
 * upper edge is pushed past the latest point by one bucket width, because the
 * last bucket is half-open and would otherwise drop the newest row.
 */
export function pointExtent(points: VolumePoint[]): { from: number; to: number } | null {
  if (points.length === 0) return null
  let from = Infinity
  let to = -Infinity
  for (const point of points) {
    from = Math.min(from, point.at)
    to = Math.max(to, point.at)
  }
  // A single instant — or many at the same instant — has no span to bucket, so
  // it is given a minute of room around it rather than a zero-width axis.
  if (to === from) return { from: from - 30_000, to: to + 30_000 }
  return { from, to: to + (to - from) / (VOLUME_BUCKETS - 1) }
}

export interface VolumeWindow {
  from: number
  to: number
  /** True while the selected time range still contains every counted row, which
   *  is what lets the heading name the range rather than the result. */
  coversRange: boolean
}

/**
 * The window the bars are drawn across. The selected range is preferred, so the
 * default answer sits in the window the user chose; an answer whose own SQL
 * reached outside that range is drawn across its own extent instead, because
 * bars nobody can see are worse than a window nobody selected.
 */
export function volumeWindow(
  points: VolumePoint[],
  rangeFrom: number,
  rangeTo: number,
): VolumeWindow {
  const inRange = points.every((point) => point.at >= rangeFrom && point.at < rangeTo)
  if (inRange) return { from: rangeFrom, to: rangeTo, coversRange: true }
  const extent = pointExtent(points)
  return extent ? { ...extent, coversRange: false } : { from: rangeFrom, to: rangeTo, coversRange: true }
}

export function bucketPoints(
  points: VolumePoint[],
  from: number,
  to: number,
  count = VOLUME_BUCKETS,
): VolumeBucket[] {
  const width = Math.max(1, (to - from) / count)
  const buckets: VolumeBucket[] = Array.from({ length: count }, (_, index) => ({
    at: from + index * width,
    endAt: from + (index + 1) * width,
    total: 0,
    failed: 0,
  }))
  for (const point of points) {
    const index = Math.floor((point.at - from) / width)
    if (index < 0 || index >= count) continue
    buckets[index].total += 1
    if (point.failed) buckets[index].failed += 1
  }
  return buckets
}

export function pointsWithinSelection(
  points: VolumePoint[],
  selection: TimeSelection | null,
): VolumePoint[] {
  if (!selection) return points
  return points.filter((point) => point.at >= selection.from && point.at < selection.to)
}

export function withinSelection(rows: TurnRow[], selection: TimeSelection | null): TurnRow[] {
  if (!selection) return rows
  return rows.filter((row) => row.startedAt >= selection.from && row.startedAt < selection.to)
}

/**
 * Axis ticks under the histogram, as bucket start instants.
 *
 * A band scale's domain is the bucket starts themselves, so a tick has to be one
 * of them: an evenly-spaced instant computed from the window would land between
 * two bands and the axis would drop it, which is how a label ends up describing
 * the bar beside the one it sits under. Evenly spaced *by index* instead, and
 * always including both ends so the axis names the window it draws.
 */
export function bucketAxisTicks(buckets: VolumeBucket[], count = 5): number[] {
  if (buckets.length <= count) return buckets.map((bucket) => bucket.at)
  const steps = Math.max(1, count - 1)
  const indexes = new Set(
    Array.from({ length: count }, (_, step) => Math.round((step * (buckets.length - 1)) / steps)),
  )
  return [...indexes].map((index) => buckets[index].at)
}

export interface VolumeStats {
  counted: number
  failed: number
  failureRate: number
  /** Null when nothing counted carries a cost — an event listing has none, and
   *  a permanent em-dash is noise rather than a measurement. */
  totalCostUsd: number | null
  p50DurationMs: number | null
  p95DurationMs: number | null
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

export function volumeStats(points: VolumePoint[]): VolumeStats {
  const failed = points.filter((point) => point.failed).length
  const costed = points.filter((point) => point.costUsd != null)
  const durations = points
    .map((point) => point.durationMs)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)
  return {
    counted: points.length,
    failed,
    failureRate: points.length ? failed / points.length : 0,
    totalCostUsd: costed.length ? costed.reduce((sum, point) => sum + (point.costUsd ?? 0), 0) : null,
    p50DurationMs: durations.length ? percentile(durations, 0.5) : null,
    // Too few durations make a p95 meaningless — the turn list uses the same rule.
    p95DurationMs: durations.length >= 4 ? percentile(durations, 0.95) : null,
  }
}
