import type { RunLogLine } from '../../../../shared/types'

// The backend remains the 20k-line source of truth. Keeping a smaller renderer
// window bounds DOM nodes, filtering passes, and duplicated string retention.
export const MAX_RENDERER_RUN_LOG_LINES = 5_000

/**
 * Merge a backend ring-buffer snapshot with deltas that arrived while the
 * snapshot RPC was in flight. Sequence numbers restart at zero for each run;
 * a live restart therefore discards older snapshot lines by timestamp.
 */
export function mergeRunLogBackfill(
  backfill: RunLogLine[],
  live: RunLogLine[],
  maxLines = MAX_RENDERER_RUN_LOG_LINES,
): RunLogLine[] {
  if (live.length === 0) return backfill.slice(-maxLines)

  const liveRestart = live.find((line) => line.seq === 0)
  const snapshot = liveRestart
    ? backfill.filter((line) => line.ts >= liveRestart.ts)
    : backfill
  const bySequence = new Map<number, RunLogLine>()
  for (const line of snapshot) bySequence.set(line.seq, line)
  // Live data wins a duplicate: it is the newer observation and preserves the
  // exact object already held by Svelte's reactive buffer.
  for (const line of live) bySequence.set(line.seq, line)
  return Array.from(bySequence.values())
    .sort((a, b) => a.seq - b.seq)
    .slice(-maxLines)
}
