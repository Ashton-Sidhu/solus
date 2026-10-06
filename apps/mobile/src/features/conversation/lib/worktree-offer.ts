import type { TranscriptItem } from './transcript-model'

type WorktreeOfferItem = Extract<TranscriptItem, { kind: 'worktree_offer' }>

/** The last two folders of a worktree path, which name it without the host's layout. */
export function shortWorktreePath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

export interface WorktreeOfferText {
  /** Uppercase eyebrow: what became of the offer. */
  eyebrow: string
  title: string
  /** The question, or why the switch failed. */
  detail: string
  /** Switch and Keep current are offered. A failed switch can be tried again. */
  canDecide: boolean
  failed: boolean
}

/** The same words as the desktop card (`worktree-offer.ts` in workspace-ui). */
export function worktreeOfferText(offer: WorktreeOfferItem): WorktreeOfferText {
  const title = `The agent is working in worktree ${offer.branch || shortWorktreePath(offer.path)} (${shortWorktreePath(offer.path)})`
  switch (offer.resolution?.decision) {
    case 'switched':
      return { eyebrow: 'Switched to the worktree', title, detail: '', canDecide: false, failed: false }
    case 'kept':
      return { eyebrow: 'Kept the current checkout', title, detail: '', canDecide: false, failed: false }
    case 'failed':
      return { eyebrow: 'Switch failed', title, detail: offer.resolution.error, canDecide: true, failed: true }
    default:
      return { eyebrow: 'Agent worktree', title, detail: 'Switch this session to it?', canDecide: true, failed: false }
  }
}
