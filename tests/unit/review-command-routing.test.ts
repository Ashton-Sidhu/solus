import { describe, expect, test } from 'bun:test'
import { isRawReviewSkill } from '@solus/server/execution/agents/review-command'

describe('review command provider routing', () => {
  test('hides the author-only skill on both providers', () => {
    expect(isRawReviewSkill({ name: 'solus-review' })).toBe(true)        // Codex
    expect(isRawReviewSkill({ name: 'solus:solus-review' })).toBe(true)  // Claude, plugin-namespaced
    expect(isRawReviewSkill({ name: 'review-guide' })).toBe(false)
    expect(isRawReviewSkill({ name: 'solus-review-notes' })).toBe(false)
  })
})
