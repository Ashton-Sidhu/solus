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
