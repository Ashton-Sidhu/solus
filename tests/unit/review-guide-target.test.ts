import { describe, expect, test } from 'bun:test'
import type { ReviewContext } from '@solus/contracts/review'
import { fingerprintReviewPatch, guideKeyFor, guideKeyForTarget } from '@solus/server/review/review-target'

const review: ReviewContext = {
  key: 'main-deadbeef',
  branch: 'main',
  targetBranch: 'main',
  baseSha: 'deadbeef',
  headSha: 'cafebabe',
  repoRoot: '/repo',
}

describe('review guide stable targets', () => {
  test('main guide identity does not include its point-in-time base SHA', () => {
    expect(guideKeyFor(review, 'branch', 'session-a')).toBe('main')
    expect(guideKeyFor({ ...review, key: 'main-newbase', baseSha: 'newbase' }, 'branch', 'session-b')).toBe('main')
  })

  test('feature branches use one slash-safe file per branch', () => {
    expect(guideKeyFor({ ...review, branch: 'feature/reviews' }, 'branch', null)).toBe('feature__reviews')
  })

  test('session guides overwrite one file belonging only to that session', () => {
    expect(guideKeyFor(review, 'session', 'session-a')).toBe('session-session-a')
    expect(guideKeyFor({ ...review, branch: 'feature/reviews' }, 'session', 'session-a')).toBe('session-session-a')
  })

  test('all typed targets have stable portable keys', () => {
    expect(guideKeyForTarget(review, { kind: 'working-tree' }, 'session-a')).toBe('working-tree-main')
    expect(guideKeyForTarget(review, { kind: 'session' }, 'session-a')).toBe('session-session-a')
    expect(guideKeyForTarget({ ...review, branch: 'feature/reviews' }, { kind: 'branch' }, null)).toBe('feature__reviews')
    expect(guideKeyForTarget(review, {
      kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 42,
    }, null)).toBe('pr-github.com-acme-app-42')
  })

  test('content fingerprints change without a HEAD change', () => {
    const staged = fingerprintReviewPatch('diff --git a/a.ts b/a.ts\n+staged')
    const unstaged = fingerprintReviewPatch('diff --git a/a.ts b/a.ts\n+staged\n+unstaged')
    const untracked = fingerprintReviewPatch('diff --git a/a.ts b/a.ts\n+staged\ndiff --git a/new.ts b/new.ts')
    expect(new Set([staged, unstaged, untracked]).size).toBe(3)
  })
})
