import type { SessionStatus } from '@solus/contracts/types'

/**
 * A session's status as a function of the facts beneath it
 * (docs/plans/derived-session-status.md). The status packs several independent
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
  /** A rate limit holds the turn, and the run does not continue past it. */
  rateLimitParked: boolean
  /** Background work the agent waits on still runs (`backgroundWorkHolds`). */
  backgroundHolds: boolean
}

/** The precedence, in one place: a parked limit, then the person, then the turn. */
export function deriveSessionStatus(facts: SessionFacts): SessionStatus {
  if (facts.rateLimitParked) return 'rate_limited'
  if (facts.pendingInput) return facts.pendingInput
  switch (facts.turn.phase) {
    case 'none': return 'idle'
    case 'starting': return 'connecting'
    case 'running': return 'running'
    case 'settled': return facts.backgroundHolds ? 'background' : facts.turn.outcome
  }
}

/**
 * Step 1 only: no turn phase is stored yet, so it is read from the status a
 * caller writes. The comparison then checks the other facts against that write.
 * Step 2 replaces this with a stored turn phase.
 */
export function turnOfStatus(status: SessionStatus): TurnPhase {
  switch (status) {
    case 'idle': return { phase: 'none' }
    case 'connecting': return { phase: 'starting' }
    case 'running':
    case 'awaiting_input':
    case 'awaiting_plan':
    case 'rate_limited': return { phase: 'running' }
    // A turn in background has settled; its outcome shows only once the work ends.
    case 'background': return { phase: 'settled', outcome: 'completed' }
    case 'completed':
    case 'failed':
    case 'interrupted':
    case 'dead': return { phase: 'settled', outcome: status }
  }
}
