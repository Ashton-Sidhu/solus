import type { StatusCardState } from '@solus/contracts/types'
import { formatStepDuration, setupSpanMs } from '@solus/contracts/setup-card'

export interface StatusCardLine {
  /** The lowercase type word: the glyph and this word carry the state. */
  type: string
  /** Counts and time only. */
  rail: string
  /** Share of steps done, for the progress seam. */
  progressPercent: number
}

/** The one-line summary of a setup card (docs/transcript-cards.md). The time
 *  comes from the host's step times; a card the client made uses
 *  `clientTotalMs`, the time this client saw. */
export function statusCardLine(card: StatusCardState, clientTotalMs: number): StatusCardLine {
  const total = card.steps.length
  // A skipped step and a step with a warning are finished: setup went past them.
  const doneCount = card.steps.filter((step) => step.status === 'done' || step.status === 'skipped' || step.status === 'warning').length
  const totalMs = setupSpanMs(card) ?? clientTotalMs
  const steps = `${total} step${total === 1 ? '' : 's'}`
  const progressPercent = total > 0 ? Math.round((doneCount / total) * 100) : 0
  if (card.status === 'error') return { type: 'failed', rail: steps, progressPercent }
  if (card.status === 'done') {
    return {
      type: 'ready',
      rail: [steps, formatStepDuration(totalMs)].filter(Boolean).join(' · '),
      progressPercent,
    }
  }
  return {
    type: 'setting up',
    rail: total > 0 ? `step ${Math.min(doneCount + 1, total)} of ${total}` : '',
    progressPercent,
  }
}
