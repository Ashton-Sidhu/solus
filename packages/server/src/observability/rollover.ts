import { rolloverSpans } from './span-table'

const ROLLOVER_INTERVAL_MS = 24 * 60 * 60 * 1000

let firstRolloverTimer: ReturnType<typeof setTimeout> | null = null
let rolloverTimer: ReturnType<typeof setInterval> | null = null

export function runMetricsRollover(retentionDays: number, now = Date.now()): number {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  return rolloverSpans(cutoff)
}

/** The first rollover waits until boot is over. It is a synchronous delete on
 *  the main thread, and the renderer's first transcript page is queued behind
 *  whatever runs during boot. */
const FIRST_ROLLOVER_DELAY_MS = 60_000

export function startMetricsRollover(getRetentionDays: () => number): () => void {
  if (rolloverTimer || firstRolloverTimer) return stopMetricsRollover
  firstRolloverTimer = setTimeout(() => {
    firstRolloverTimer = null
    runMetricsRollover(getRetentionDays())
    rolloverTimer = setInterval(() => runMetricsRollover(getRetentionDays()), ROLLOVER_INTERVAL_MS)
    rolloverTimer.unref?.()
  }, FIRST_ROLLOVER_DELAY_MS)
  firstRolloverTimer.unref?.()
  return stopMetricsRollover
}

export function stopMetricsRollover(): void {
  if (firstRolloverTimer) clearTimeout(firstRolloverTimer)
  firstRolloverTimer = null
  if (!rolloverTimer) return
  clearInterval(rolloverTimer)
  rolloverTimer = null
}
