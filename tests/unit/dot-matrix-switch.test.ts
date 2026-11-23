import { describe, expect, test } from 'bun:test'
import { DOT_MARKS } from '@solus/client-core/dot-marks'
import {
  DOT_MATRIX_BOX_PX,
  dotAnimationKeyframes,
  dotCellOffset,
  msUntilCycleEnd,
  planDotMarkSwitch,
} from '@solus/workspace-ui/components/ui/lib/dot-matrix'

// The DotMatrix holds a mark for whole cycles (docs/plans/session-state-marks.md):
// an activity changes several times a second, and a mark cut mid-cycle reads
// as noise, not as a state.

const thinking = DOT_MARKS.thinking.durationMs

describe('switching dot marks at the end of a cycle', () => {
  test('waits for the end of the cycle on screen, counted from the timeline origin', () => {
    // WHY: every copy starts at the timeline origin, so all copies of a mark
    // switch on the same frame.
    const decision = planDotMarkSwitch({ shown: 'thinking', requested: 'editing', shownDurationMs: thinking, timelineMs: thinking * 3 + 100, reducedMotion: false })
    expect(decision.kind).toBe('atCycleEnd')
    expect(decision.kind === 'atCycleEnd' && decision.delayMs).toBeCloseTo(thinking - 100, 6)
  })

  test('the same mark asked for again keeps the one on screen', () => {
    // WHY: a mark asked for and then undone inside the wait never shows; the
    // cycle that runs is not cut.
    expect(planDotMarkSwitch({ shown: 'thinking', requested: 'thinking', shownDurationMs: thinking, timelineMs: 5, reducedMotion: false }))
      .toEqual({ kind: 'keep' })
  })

  test('switches at once with nothing on screen, or with reduced motion', () => {
    // A still mark has no cycle to finish.
    expect(planDotMarkSwitch({ shown: null, requested: 'reading', shownDurationMs: 0, timelineMs: 5, reducedMotion: false }))
      .toEqual({ kind: 'now' })
    expect(planDotMarkSwitch({ shown: 'thinking', requested: 'reading', shownDurationMs: thinking, timelineMs: 5, reducedMotion: true }))
      .toEqual({ kind: 'now' })
  })

  test('a time on a cycle edge waits one whole cycle', () => {
    expect(msUntilCycleEnd(2_400 * 2, 2_400)).toBe(2_400)
    expect(msUntilCycleEnd(2_400 * 2 + 1, 2_400)).toBe(2_399)
  })
})

describe('the dots of the grid', () => {
  test('animate only transform: scale, and keep each segment easing', () => {
    const keyframes = dotAnimationKeyframes([
      { offset: 0, scale: 0, easing: 'cubic-bezier(.3,0,.2,1)' },
      { offset: 1, scale: 1 },
    ])
    expect(keyframes).toEqual([
      { offset: 0, transform: 'scale(0)', easing: 'cubic-bezier(.3,0,.2,1)' },
      { offset: 1, transform: 'scale(1)' },
    ])
  })

  test('the default grid is the 13px box of a line glyph', () => {
    expect(DOT_MATRIX_BOX_PX).toBe(13)
    expect(dotCellOffset(2, DOT_MATRIX_BOX_PX)).toBe(10)
  })
})
