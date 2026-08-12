import { describe, expect, test } from 'bun:test'
import {
  statusDotColor,
  statusPillColors,
} from '../../src/renderer/components/pr-review/lib/pr-status'

describe('pull request lifecycle tones', () => {
  test('uses the task status semantics in review surfaces', () => {
    // WHY: list, detail, and session chips must give the same status the same
    // color instead of reverting to the brown brand accent or old PR palette.
    expect(statusDotColor('open')).toContain('var(--running)')
    expect(statusDotColor('review')).toContain('var(--review)')
    expect(statusDotColor('merged')).toContain('var(--success)')
    expect(statusPillColors('closed')).toEqual({
      background: 'var(--wash-3)',
      color: 'var(--muted-foreground)',
    })
  })
})
