import type { PrReviewer } from '@solus/contracts/providers'

/** How a reviewer's standing reads in the rail: one lower-case word in the
 *  verdict's own colour. The rail states the verdict as text rather than as a
 *  pill — a column of reviewers is scanned, and a filled badge per row competes
 *  with the name it belongs to. */
export function reviewerStateLabel(state: PrReviewer['state']): string {
  switch (state) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes'
    case 'COMMENTED':
      return 'commented'
    case 'DISMISSED':
      return 'dismissed'
    default:
      return 'pending'
  }
}

/** Only a blocking verdict earns colour. The label already states approval,
 *  so successful and pending reviews stay neutral instead of making the rail
 *  alternate between green and red. */
export function reviewerStateColor(state: PrReviewer['state']): string {
  switch (state) {
    case 'CHANGES_REQUESTED':
      return 'var(--solus-art-negative)'
    default:
      return 'var(--muted-foreground)'
  }
}

/** The ring around a reviewer's avatar where the rail has no room for its
 *  rows: a verdict that changes what happens next earns a colour, a pending
 *  or neutral review does not — the row is a glance, and the name and the
 *  word stay on the title. */
export function reviewerRingColor(state: PrReviewer['state']): string | null {
  switch (state) {
    case 'APPROVED':
      return 'var(--solus-art-positive)'
    case 'CHANGES_REQUESTED':
      return 'var(--solus-art-negative)'
    default:
      return null
  }
}

export interface ReviewerRowAction {
  kind: 'remove' | 're-request'
  label: string
}

/**
 * The one thing you can do to a reviewer from their row, shown in place of the
 * verdict while the row is hovered. Someone still to answer can be taken off
 * the request; someone who has answered can be asked again, which is how a
 * stale approval or a resolved change request gets a fresh look after new
 * commits. Both are the host's own operations — a re-request is a request for
 * a login that has already reviewed.
 */
export function reviewerRowAction(state: PrReviewer['state']): ReviewerRowAction {
  return state === null
    ? { kind: 'remove', label: 'Remove' }
    : { kind: 're-request', label: 'Re-request' }
}
