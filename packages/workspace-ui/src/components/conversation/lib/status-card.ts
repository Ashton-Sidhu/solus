import type { StatusCardState } from '@solus/contracts/types'
import { formatStepDuration } from './setup-timing.svelte'

export interface StatusCardLine {
  /** The lowercase type word: the glyph and this word carry the state. */
  type: string
  /** Counts and time only. */
  rail: string
  /** Share of steps done, for the progress seam. */
  progressPercent: number
}

/** The one-line summary of a setup card (docs/transcript-cards.md). */
export function statusCardLine(card: StatusCardState, totalMs: number): StatusCardLine {
  const total = card.steps.length
  const doneCount = card.steps.filter((step) => step.status === 'done').length
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
