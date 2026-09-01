import { describe, expect, test } from 'bun:test'
import type { ReviewEffort } from '../../src/shared/effort-types'
import type { ReviewSessionCoreEntry } from '../../src/renderer/components/review-mode/lib/review-session-core'
import {
  defaultReviewModeView,
  deriveQueueRows,
} from '../../src/renderer/components/review-mode/lib/review-mode-model'

function effort(band: ReviewEffort['band'], minutes: number): ReviewEffort {
  return { band, minutes, signals: [`${band} review`] }
}

function entry(prNumber: number): ReviewSessionCoreEntry {
  return {
    prNumber,
    outcome: null,
    openedAt: null,
    dwellMs: 0,
    flushError: null,
  }
}

describe('review mode presentation model', () => {
  test('quick work bypasses guide generation while unknown effort takes the guided default', () => {
    expect(defaultReviewModeView(effort('quick', 2))).toBe('diff')
    expect(defaultReviewModeView(effort('standard', 5))).toBe('guide')
    expect(defaultReviewModeView(effort('involved', 12))).toBe('guide')
    expect(defaultReviewModeView()).toBe('guide')
  })

  test('rail rows expose a held decision without treating it as a settled core outcome', () => {
    const rows = deriveQueueRows(
      [
        { number: 12, title: 'Small fix', author: 'sam', effort: effort('quick', 2) },
        { number: 18, title: 'Unknown size', author: 'lee' },
      ],
      [entry(12), entry(18)],
      [{ prNumber: 12, outcome: 'approved', heldAt: 1_000 }],
      1,
      new Map([[12, 3]]),
      3_500,
    )

    expect(rows[0]).toMatchObject({
      position: 1,
      band: 'quick',
      minutes: 2,
      outcome: 'approved',
      pending: true,
      holdProgress: 0.5,
      unresolvedThreads: 3,
      flushError: null,
      active: false,
    })
    expect(rows[1]).toMatchObject({
      position: 2,
      band: 'standard',
      minutes: null,
      outcome: null,
      pending: false,
      unresolvedThreads: null,
      active: true,
    })
  })
})
