import { describe, expect, test } from 'bun:test'
import type { ReviewContext } from '../../src/shared/review'
import { guideKeyFor } from '../../src/main/review/review-target'

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
})
