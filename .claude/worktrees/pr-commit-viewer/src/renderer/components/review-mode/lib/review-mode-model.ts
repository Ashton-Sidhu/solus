import type { ReviewEffort, EffortBand } from '../../../../shared/effort-types'
import type {
  PendingDisposition,
  ReviewOutcome,
} from '../../../../shared/review-session-types'
import type { ReviewSessionCoreEntry } from './review-session-core'
import { HOLD_MS } from './review-session-core'

export type ReviewModeView = 'activity' | 'guide' | 'diff'

export interface ReviewModeQueueItem {
  number: number
  title: string
  author: string
  effort?: ReviewEffort
}

export interface ReviewModeQueueRow extends ReviewModeQueueItem {
  position: number
  band: EffortBand | null
  minutes: number | null
  outcome: ReviewOutcome | null
  pending: boolean
  holdProgress: number
  unresolvedThreads: number | null
  flushError: string | null
  active: boolean
}

/** Quick reviews lead with the complete diff; everything else starts from the guide. */
export function defaultReviewModeView(effort?: ReviewEffort): ReviewModeView {
  return effort?.band === 'quick' ? 'diff' : 'guide'
}

export function deriveQueueRows(
  items: ReviewModeQueueItem[],
  entries: ReviewSessionCoreEntry[],
  pending: PendingDisposition[],
  cursor: number,
  unresolvedByPr: ReadonlyMap<number, number>,
  now = Date.now(),
): ReviewModeQueueRow[] {
  const itemsByNumber = new Map(items.map((item) => [item.number, item]))
  const pendingByNumber = new Map(pending.map((item) => [item.prNumber, item]))

  return entries.flatMap((entry, index) => {
    const item = itemsByNumber.get(entry.prNumber)
    if (!item) return []
    const held = pendingByNumber.get(entry.prNumber)
    return [{
      ...item,
      position: index + 1,
      band: item.effort?.band ?? null,
      minutes: item.effort?.minutes ?? null,
      outcome: held?.outcome ?? entry.outcome,
      pending: !!held,
      holdProgress: held
        ? Math.max(0, Math.min(1, (held.heldAt + HOLD_MS - now) / HOLD_MS))
        : 0,
      unresolvedThreads: unresolvedByPr.get(entry.prNumber) ?? null,
      flushError: entry.flushError,
      active: index === cursor,
    }]
  })
}

export function formatReviewDwell(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function reviewOutcomeLabel(outcome: ReviewOutcome): string {
  switch (outcome) {
    case 'approved': return 'Approved'
    case 'changes_requested': return 'Changes requested'
    case 'commented': return 'Commented'
    case 'deferred': return 'Deferred'
    case 'skipped': return 'Skipped'
  }
}
