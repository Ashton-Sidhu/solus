import type { SessionStatus } from '@solus/contracts/types'

/** What a screen reader hears when a turn changes phase. */
export type TurnPhase = 'Working' | 'Needs approval' | 'Needs your input' | 'Done' | 'Failed' | 'Stopped'

/**
 * The phase a session status names, or null for a status that is not a turn
 * phase (idle, connecting, rate limited: each has its own surface or none).
 * `awaitingApproval` is true when the input the agent waits for is a
 * permission request rather than a question.
 */
export function turnPhaseFor(status: SessionStatus, awaitingApproval: boolean): TurnPhase | null {
  switch (status) {
    case 'running':
      return 'Working'
    case 'awaiting_plan':
      return 'Needs approval'
    case 'awaiting_input':
      return awaitingApproval ? 'Needs approval' : 'Needs your input'
    case 'completed':
    case 'background':
      return 'Done'
    case 'failed':
    case 'dead':
      return 'Failed'
    case 'interrupted':
      return 'Stopped'
    default:
      return null
  }
}

/**
 * Turns the phases of the conversation a pane shows into what a screen reader
 * hears. Only a change the reader did not cause by looking is spoken: the
 * first phase seen for a conversation is the baseline, and a switch to another
 * conversation clears the live region without speaking. Web and mobile both
 * read turns through this.
 */
export class TurnAnnouncer {
  private conversationId: string | null = null
  private phase: TurnPhase | null = null
  /** The text of the pane's live region. */
  text = ''

  /** The phase to speak now, or null when this observation is silent. */
  observe(conversationId: string, phase: TurnPhase | null): TurnPhase | null {
    if (conversationId !== this.conversationId) {
      this.conversationId = conversationId
      this.phase = phase
      this.text = ''
      return null
    }
    if (phase === null || phase === this.phase) return null
    const isBaseline = this.phase === null
    this.phase = phase
    if (isBaseline) return null
    this.text = phase
    return phase
  }
}
