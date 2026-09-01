import type { TurnRow } from './turn-rows'

// Where one turn sits among every turn in the window.
//
// The strip counts three things at once — every turn in the window, the ones
// belonging to the session being read, and the one being read now — off one
// bucketing, so the three bar layers are three readings of the same bucket
// rather than three filtered copies of it.
//
// Pure and non-reactive: the component reads these from `$derived`.

export interface SessionContextBucket {
  /** Bucket start, epoch ms — the band domain, as in the volume histogram. */
  at: number
  endAt: number
  /** Every turn in the window that landed here. */
  total: number
  /** Of those, the ones in the session being read. */
  sessionCount: number
  failed: number
  /** The bucket holding the turn being read. */
  isCurrent: boolean
}

export interface SessionContextInput {
  /** Every turn the window holds, across all sessions. */
  rows: TurnRow[]
  /** The session being read; null leaves every bar an outside one. */
  sessionId: string | null
  currentTraceId: string
  /** Places the turn being read even when the window's rows do not hold it —
   *  a deep-linked turn the current answer never listed still marks its bar. */
  currentStartedAt: number
  from: number
  to: number
  count: number
}

export function sessionContextBuckets(input: SessionContextInput): SessionContextBucket[] {
  const { rows, sessionId, currentTraceId, currentStartedAt, from, to, count } = input
  const width = Math.max(1, (to - from) / count)
  const buckets: SessionContextBucket[] = Array.from({ length: count }, (_, index) => ({
    at: from + index * width,
    endAt: from + (index + 1) * width,
    total: 0,
    sessionCount: 0,
    failed: 0,
    isCurrent: false,
  }))
  for (const bucket of buckets) {
    bucket.isCurrent = currentStartedAt >= bucket.at && currentStartedAt < bucket.endAt
  }
  for (const row of rows) {
    const index = Math.floor((row.startedAt - from) / width)
    if (index < 0 || index >= count) continue
    const bucket = buckets[index]
    bucket.total += 1
    if (row.sessionId === sessionId && sessionId != null) bucket.sessionCount += 1
    if (row.status === 'error' || row.status === 'interrupted') bucket.failed += 1
    if (row.traceId === currentTraceId) bucket.isCurrent = true
  }
  return buckets
}
