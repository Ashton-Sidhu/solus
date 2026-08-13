import { describe, expect, test } from 'bun:test'
import {
  statusDotColor,
  statusPillColors,
} from '../../src/renderer/components/pr-review/lib/pr-status'

describe('pull request lifecycle tones', () => {
  test('uses conventional Git host semantics in review surfaces', () => {
    // WHY: list and detail surfaces must keep open green, merged purple, and
    // closed red instead of borrowing the task lifecycle palette.
    expect(statusDotColor('open')).toContain('var(--success)')
    expect(statusDotColor('review')).toContain('var(--review)')
    expect(statusDotColor('merged')).toContain('var(--review)')
    expect(statusDotColor('closed')).toContain('var(--failure)')
    expect(statusPillColors('closed').color).toContain('var(--failure)')
  })
})
