import type { MetricsSessionSummary } from '@solus/contracts/observability-types'
import { singleLine } from './format'
import type { TurnRow } from './turn-rows'
import { isFailedStatus } from './volume'

// The session a turn belongs to, read as a sequence.
//
// The rollup is a list of turns with every measure the query could report. This
// view is not: a reader is asking where in the session they are and what the
// neighbours were, and every extra number printed on a row is one more thing
// between them and that answer. So a row prints what identifies a turn — its
// ordinal, what was asked, how long it took — and everything else it recorded
// travels with it for the hover card, which is where a reader asks the second
// question about one row rather than about all of them at once.
//
// Pure and non-reactive: the component reads these from `$derived`.

export interface SessionTurnRow {
  traceId: string
  turnNumber: number
  startedAt: number
  durationMs: number | null
  status: string
  /** What the turn asked. The window's rows carry the full text; the rollup
   *  carries a capped line for every other turn. Only a turn that recorded no
   *  ask at all falls back to the session's name — a column repeating one name
   *  identifies nothing, which is the whole point of the column. */
  title: string
  isCurrent: boolean
  failed: boolean
  /** Everything the row does not print, for the hover card. */
  model: string | null
  origin: string | null
  tokens: number | null
  costUsd: number | null
  toolCallCount: number | null
}

export interface SessionSummaryView {
  rows: SessionTurnRow[]
  /** 1-based place of the turn being read; 0 when the session does not hold it. */
  position: number
  turnCount: number
}

/** The prompt text the current answer holds, by trace. A session rollup never
 *  carries prompts, so rows outside the answer fall back to the session name. */
export function promptsByTrace(rows: TurnRow[]): Map<string, string> {
  const prompts = new Map<string, string>()
  for (const row of rows) {
    const prompt = singleLine(row.prompt)
    if (prompt) prompts.set(row.traceId, prompt)
  }
  return prompts
}

export function sessionSummaryView(
  session: MetricsSessionSummary,
  prompts: Map<string, string>,
  currentTraceId: string,
  /** How the host lists this session, when it still holds it. */
  sessionName: string | null,
): SessionSummaryView {
  const rows = session.turns.map((turn) => ({
    traceId: turn.traceId,
    turnNumber: turn.turnNumber,
    startedAt: turn.startedAt,
    durationMs: turn.durationMs,
    status: turn.status,
    title:
      prompts.get(turn.traceId) ||
      singleLine(turn.prompt) ||
      sessionName ||
      'No prompt text recorded',
    isCurrent: turn.traceId === currentTraceId,
    failed: isFailedStatus(turn.status),
    model: turn.model,
    origin: turn.origin,
    tokens:
      turn.inputTokens == null && turn.outputTokens == null
        ? null
        : (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0),
    costUsd: turn.costUsd,
    toolCallCount: turn.toolCallCount,
  }))
  return {
    rows,
    position: rows.findIndex((row) => row.isCurrent) + 1,
    turnCount: session.turnCount,
  }
}
