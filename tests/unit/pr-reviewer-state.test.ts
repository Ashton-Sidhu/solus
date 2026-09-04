import { describe, expect, test } from 'bun:test'
import {
  reviewerRowAction,
  reviewerStateColor,
  reviewerStateLabel,
} from '@solus/workspace-ui/components/pr-review/lib/reviewer-state'

describe('the reviewer row', () => {
  test('offers to take back a request nobody has answered', () => {
    // WHY: a pending request is the only state the host lets you undo. The
    // row used to draw an ✕ beside the verdict word, which pushed pending
    // rows' verdicts out of line with the rest; the action now stands in for
    // the word, so it has to be the one action that makes sense for null.
    expect(reviewerRowAction(null)).toEqual({ kind: 'remove', label: 'Remove' })
  })

  test('offers to ask again once someone has answered', () => {
    // WHY: an approval from before the last push, or a change request that
    // has since been addressed, needs a fresh look. GitHub's re-request is a
    // request for a login that already reviewed, so every answered state
    // maps to the same action.
    for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'] as const) {
      expect(reviewerRowAction(state)).toEqual({ kind: 're-request', label: 'Re-request' })
    }
  })

  test('colours only the verdict that blocks the merge', () => {
    expect(reviewerStateColor('CHANGES_REQUESTED')).toBe('var(--solus-art-negative)')
    expect(reviewerStateColor('APPROVED')).toBe('var(--muted-foreground)')
    expect(reviewerStateColor(null)).toBe('var(--muted-foreground)')
    expect(reviewerStateLabel(null)).toBe('pending')
  })
})
