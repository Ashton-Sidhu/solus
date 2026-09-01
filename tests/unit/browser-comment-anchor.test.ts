import { describe, expect, test } from 'bun:test'
import { commentAnchorPosition } from '@solus/workspace-ui/components/browser/lib/comment-anchor'

/**
 * The comment composer sits on its mark, in the frame's coordinate space.
 *
 * The mark is in the guest's own pixels; the frame paints that viewport scaled
 * to fit. These pin the mapping (guest × scale), the flip when there is no room
 * below, and the clamp that keeps it on the frame.
 */

const FRAME = { width: 800, height: 600 }
const POPUP = { width: 240, height: 72 }

describe('commentAnchorPosition', () => {
  test('maps the mark by the frame scale and sits just below it', () => {
    // A pin at guest (100, 50) with the frame at half scale is at (50, 25); the
    // composer drops 8px under the mark's scaled bottom.
    const pos = commentAnchorPosition(
      { x: 100, y: 50, width: 0, height: 0 },
      0.5,
      FRAME,
      POPUP,
    )
    expect(pos.left).toBe(50)
    expect(pos.top).toBe(25 + 8)
  })

  test('flips above the mark when there is no room below', () => {
    // A mark near the bottom would push the popup off the frame, so it opens
    // upward instead — its bottom above the mark.
    const pos = commentAnchorPosition(
      { x: 100, y: 580, width: 0, height: 0 },
      1,
      FRAME,
      POPUP,
    )
    expect(pos.top).toBe(580 - POPUP.height - 8)
  })

  test('never runs off the right edge', () => {
    // A mark hard against the right keeps the whole popup on the frame.
    const pos = commentAnchorPosition(
      { x: 790, y: 100, width: 0, height: 0 },
      1,
      FRAME,
      POPUP,
    )
    expect(pos.left).toBe(FRAME.width - POPUP.width - 6)
  })

  test('never runs off the left edge', () => {
    const pos = commentAnchorPosition(
      { x: -20, y: 100, width: 0, height: 0 },
      1,
      FRAME,
      POPUP,
    )
    expect(pos.left).toBe(6)
  })
})
