import type { SessionStatus } from '@solus/contracts/types'

/**
 * A session's status as a function of the facts beneath it
 * (plans/037-turn-owned-session-status.md). The status packs several independent
 * facts into one value; only the turn phase is a state machine of its own.
 */

export type TurnOutcome = 'completed' | 'failed' | 'interrupted' | 'dead'

/** Where the session's current turn is. */
export type TurnPhase =
  | { phase: 'none' }
  | { phase: 'starting' }
  | { phase: 'running' }
  | { phase: 'settled'; outcome: TurnOutcome }

export interface SessionFacts {
  turn: TurnPhase
  /** What the person must answer: a plan alone, or any other request. */
  pendingInput: 'awaiting_input' | 'awaiting_plan' | null
  /** A rate limit parked the turn, and the run does not continue past it. */
  rateLimitParked: boolean
  /** Background work the agent waits on still runs (`backgroundWorkHolds`). */
  backgroundWorkHolds: boolean
  /** A session it sent work to has still to report, or a live MCP task runs (`holdsOutsideRun`). */
  holdsOutsideRun: boolean
  /** The turn has settled, and a queued prompt takes the session over. */
  queueTakesOver: boolean
}

/** The precedence, in one place: a parked limit, then the person, then the turn. */
export function deriveSessionStatus(facts: SessionFacts): SessionStatus {
  if (facts.rateLimitParked) return 'rate_limited'
  const turn = facts.turn
  // A stopped turn waits for no answer: its run exits and expires the request.
  const isStopped = turn.phase === 'settled' && turn.outcome === 'interrupted'
  if (facts.pendingInput && !isStopped) return facts.pendingInput
  switch (turn.phase) {
    case 'none': return 'idle'
    case 'starting': return 'connecting'
    case 'running': return 'running'
    case 'settled':
      // No client sees the session finish between a turn and the queued prompt after it.
      if (facts.queueTakesOver) return 'running'
      // A turn whose work still runs waits in 'background', so that work stays
      // visible and stoppable. A failed turn waits for its own work only: its
      // failure is reported at once, and the wait ends as 'failed'. A stopped
      // or dead turn leaves no wait.
      if (turn.outcome === 'completed' && (facts.backgroundWorkHolds || facts.holdsOutsideRun)) return 'background'
      if (turn.outcome === 'failed' && facts.backgroundWorkHolds) return 'background'
      return turn.outcome
  }
}
