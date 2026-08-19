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

/** Only a verdict earns colour. Requested-but-unanswered stays muted, so the
 *  two colours in the column always mean "done" and "blocked". */
export function reviewerStateColor(state: PrReviewer['state']): string {
  switch (state) {
    case 'APPROVED':
      return 'var(--solus-art-positive)'
    case 'CHANGES_REQUESTED':
      return 'var(--solus-art-negative)'
    default:
      return 'var(--muted-foreground)'
  }
}
