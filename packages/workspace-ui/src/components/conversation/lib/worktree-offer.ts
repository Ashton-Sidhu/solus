import type { Activity, WorktreeOfferResolution } from '@solus/contracts/activity'
import type { Message } from '@solus/contracts/types'

/**
 * The worktree offer card (docs/worktree-names.md, "Agent worktrees"). The host
 * records the offer and its answer as two activities. The transcript keeps one
 * row: the answer folds onto the offer, so the card shows its state after a
 * reload too.
 */

export type WorktreeOffer = Extract<Activity, { kind: 'worktree_offered' }>
type WorktreeOfferDecided = Extract<Activity, { kind: 'worktree_offer_decided' }>

/** Put an answer on its offer row. False when the offer is not loaded. */
export function applyWorktreeOfferResolution(
  messages: readonly Message[],
  offerId: string,
  resolution: WorktreeOfferResolution,
): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const activity = messages[index].activity
    if (activity?.kind !== 'worktree_offered' || activity.id !== offerId) continue
    // One property changes; the row and its transcript stay the same objects.
    activity.resolution = resolution
    return true
  }
  return false
}

/** Fold a `worktree_offer_decided` activity. It never draws a row of its own. */
export function foldWorktreeOfferDecision(messages: readonly Message[], decided: WorktreeOfferDecided): void {
  applyWorktreeOfferResolution(messages, decided.offerId, decided.resolution)
}

/** The last two folders of a worktree path, which name it without the host's layout. */
export function shortWorktreePath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

export interface WorktreeOfferView {
  title: string
  /** Lowercase type word: what became of the offer. */
  type: string
  target: string
  /** Why the switch failed; empty otherwise, so the card stays one line. */
  detail: string
  /** Switch and Keep current are offered. A failed switch can be tried again. */
  canDecide: boolean
  failed: boolean
}

export function worktreeOfferView(offer: WorktreeOffer): WorktreeOfferView {
  // The title names no path: the target shows the branch, or the path when there is none.
  const base = {
    title: 'The agent is working in another worktree',
    target: offer.branch || shortWorktreePath(offer.path),
  }
  switch (offer.resolution?.decision) {
    case 'switched':
      return { ...base, type: 'switched', detail: '', canDecide: false, failed: false }
    case 'kept':
      return { ...base, type: 'kept current', detail: '', canDecide: false, failed: false }
    case 'failed':
      return { ...base, type: 'failed', detail: `The switch failed: ${offer.resolution.error}`, canDecide: true, failed: true }
    default:
      return { ...base, type: 'worktree', detail: '', canDecide: true, failed: false }
  }
}
