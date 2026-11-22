import { describe, expect, test } from 'bun:test'
import { reviewGuideKeyForTarget } from '@solus/contracts/review'
import { fingerprintReviewPatch } from '@solus/server/review/review-target'

describe('review guide stable targets', () => {
  test('branch, working tree, and pull request guides have distinct storage keys', () => {
    expect(reviewGuideKeyForTarget({ kind: 'branch' }, 'main')).toBe('main')
    expect(reviewGuideKeyForTarget({ kind: 'working-tree' }, 'main')).toBe('working-tree-main')
    expect(reviewGuideKeyForTarget({ kind: 'branch' }, 'feature/reviews')).toBe('feature__reviews')
    expect(reviewGuideKeyForTarget({
      kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 42,
    }, '')).toBe('pr-github.com-acme-app-42')
  })

  test('content fingerprints change without a HEAD change', () => {
    const staged = fingerprintReviewPatch('diff --git a/a.ts b/a.ts\n+staged')
    const unstaged = fingerprintReviewPatch('diff --git a/a.ts b/a.ts\n+staged\n+unstaged')
    const untracked = fingerprintReviewPatch('diff --git a/a.ts b/a.ts\n+staged\ndiff --git a/new.ts b/new.ts')
    expect(new Set([staged, unstaged, untracked]).size).toBe(3)
  })
})
