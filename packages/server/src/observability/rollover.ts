import { rolloverSpans } from './span-table'

const ROLLOVER_INTERVAL_MS = 24 * 60 * 60 * 1000

let rolloverTimer: ReturnType<typeof setInterval> | null = null

export function runMetricsRollover(retentionDays: number, now = Date.now()): number {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  return rolloverSpans(cutoff)
}

export function startMetricsRollover(getRetentionDays: () => number): () => void {
  if (rolloverTimer) return stopMetricsRollover
  runMetricsRollover(getRetentionDays())
  rolloverTimer = setInterval(() => runMetricsRollover(getRetentionDays()), ROLLOVER_INTERVAL_MS)
  rolloverTimer.unref?.()
  return stopMetricsRollover
}

export function stopMetricsRollover(): void {
  if (!rolloverTimer) return
  clearInterval(rolloverTimer)
  rolloverTimer = null
}
