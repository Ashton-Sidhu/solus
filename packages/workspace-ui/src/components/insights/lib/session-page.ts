import type { MetricsSessionSummary, MetricsTurnSummary } from '@solus/contracts/observability-types'
import { singleLine } from './format'
import { isFailedStatus } from './volume'

// One session, read as a sequence: every turn on one axis, with what each one
// cost and where it left the context. "Why is this session slow" is answered
// here, not on any one turn.
//
// Pure and non-reactive: the page reads these from `$derived`.

export interface SessionTurnPoint {
  traceId: string
  turnNumber: number
  startedAt: number
  durationMs: number | null
  failed: boolean
  title: string
  costUsd: number | null
  /** Every turn's cost up to and including this one; null until any turn
   *  reported a cost. */
  cumulativeCostUsd: number | null
  tokens: number | null
  /** Tokens the context held after this turn, when the turn recorded it. */
  contextUsedTokens: number | null
}

export interface SessionPageStats {
  turnCount: number
  failedCount: number
  totalDurationMs: number
  totalCostUsd: number | null
  totalTokens: number
  medianDurationMs: number | null
  /** The turn that took longest, for the page to point at. */
  longest: SessionTurnPoint | null
  /** Context after the last turn that recorded it. */
  lastContextUsedTokens: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function titleOf(turn: MetricsTurnSummary): string {
  return singleLine(turn.prompt) || 'No prompt text recorded'
}

export function sessionTurnPoints(session: MetricsSessionSummary): SessionTurnPoint[] {
  let cumulative: number | null = null
  return session.turns.map((turn) => {
    if (turn.costUsd != null) cumulative = (cumulative ?? 0) + turn.costUsd
    return {
      traceId: turn.traceId,
      turnNumber: turn.turnNumber,
      startedAt: turn.startedAt,
      durationMs: turn.durationMs,
      failed: isFailedStatus(turn.status),
      title: titleOf(turn),
      costUsd: turn.costUsd,
      cumulativeCostUsd: cumulative,
      tokens:
        turn.inputTokens == null && turn.outputTokens == null
          ? null
          : (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0),
      contextUsedTokens: turn.contextUsedTokens ?? null,
    }
  })
}

export function sessionPageStats(session: MetricsSessionSummary, points: SessionTurnPoint[]): SessionPageStats {
  const durations = points.map((point) => point.durationMs).filter((value): value is number => value != null)
  const longest = points.reduce<SessionTurnPoint | null>(
    (best, point) => (point.durationMs != null && (best?.durationMs ?? -1) < point.durationMs ? point : best),
    null,
  )
  const withContext = points.filter((point) => point.contextUsedTokens != null)
  return {
    turnCount: session.turnCount,
    failedCount: points.filter((point) => point.failed).length,
    totalDurationMs: session.totalDurationMs,
    totalCostUsd: session.totalCostUsd,
    totalTokens: session.totalInputTokens + session.totalOutputTokens,
    medianDurationMs: median(durations),
    longest,
    lastContextUsedTokens: withContext.length ? withContext[withContext.length - 1].contextUsedTokens : null,
  }
}
