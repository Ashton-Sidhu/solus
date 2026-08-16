import type { TurnRow } from './turn-rows'

// The turn-volume histogram and the brush that narrows the list.
//
// The histogram is the context the answer sits in, so it is bucketed over a
// fixed window rather than over whatever the current query returned. Brushing
// selects a time range; the list then filters to it. Pure and non-reactive.

/** Buckets across the window. 48 over 24 hours is one bar per half hour — fine
 *  enough to show a spike, coarse enough that a bar is still clickable. */
export const VOLUME_BUCKETS = 48

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

export function bucketTurns(rows: TurnRow[], from: number, to: number): VolumeBucket[] {
  const width = Math.max(1, (to - from) / VOLUME_BUCKETS)
  const buckets: VolumeBucket[] = Array.from({ length: VOLUME_BUCKETS }, (_, index) => ({
    at: from + index * width,
    endAt: from + (index + 1) * width,
    total: 0,
    failed: 0,
  }))
  for (const row of rows) {
    const index = Math.floor((row.startedAt - from) / width)
    if (index < 0 || index >= VOLUME_BUCKETS) continue
    buckets[index].total += 1
    if (row.status === 'error' || row.status === 'interrupted') buckets[index].failed += 1
  }
  return buckets
}

export function withinSelection(rows: TurnRow[], selection: TimeSelection | null): TurnRow[] {
  if (!selection) return rows
  return rows.filter((row) => row.startedAt >= selection.from && row.startedAt < selection.to)
}

/** Axis ticks under the histogram: five evenly spaced instants across the
 *  window, oldest first, matching the bar order. */
export function volumeAxisTicks(from: number, to: number): number[] {
  return [0, 1, 2, 3, 4].map((step) => Math.round(from + ((to - from) / 4) * step))
}

export interface VolumeStats {
  turns: number
  failed: number
  failureRate: number
  totalCostUsd: number | null
  p95DurationMs: number | null
}

export function volumeStats(rows: TurnRow[]): VolumeStats {
  const failed = rows.filter((row) => row.status === 'error' || row.status === 'interrupted').length
  const costed = rows.filter((row) => row.costUsd != null)
  const durations = rows
    .map((row) => row.durationMs)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)
  return {
    turns: rows.length,
    failed,
    failureRate: rows.length ? failed / rows.length : 0,
    totalCostUsd: costed.length ? costed.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) : null,
    p95DurationMs: durations.length
      ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
      : null,
  }
}
