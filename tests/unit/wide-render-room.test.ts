import { describe, expect, test } from 'bun:test'
import type { ConversationWidth } from '@solus/contracts/settings'
import { wideRenderRoom } from '@solus/workspace-ui/components/conversation/lib/html-block-origin'
import { gutterWidth, hasRoomForRail } from '@solus/workspace-ui/components/conversation/lib/minimap'

// Widen lets a render in a conversation grow past the reading column into the
// pane's gutters. It must never paint under the message navigator, which sits
// in the left gutter, and it must not offer a control that changes nothing.

// The navigator rail: 16px from the pane edge, then a 6px pad, an 11px dash,
// a 6px pad, and its 1px borders.
const RAIL_RIGHT_EDGE = 16 + 1 + 6 + 11 + 6 + 1
// MessageHoverRail, in a reply with a widened render, keeps 3rem for the
// navigator and hangs 0.625rem left of the render. A stacked clock ("12:19"
// over "AM", or "Nov 24") needs about 40px.
const NAVIGATOR_CLEAR = 48
const RAIL_MARGIN = 10
const STACKED_TIME = 40

function roomAt(paneWidth: number, width: ConversationWidth) {
  const gutter = gutterWidth(paneWidth, width)
  const column = paneWidth - 2 * gutter
  return { gutter, room: wideRenderRoom(paneWidth, column) }
}

describe('wide render room', () => {
  test('a widened render stays clear of the message navigator', () => {
    for (const width of ['narrow', 'comfortable'] as const) {
      for (let paneWidth = 360; paneWidth <= 3200; paneWidth += 40) {
        const { gutter, room } = roomAt(paneWidth, width)
        if (room === 0 || !hasRoomForRail(paneWidth, width)) continue
        expect(gutter - room).toBeGreaterThanOrEqual(RAIL_RIGHT_EDGE)
      }
    }
  })

  test('the time rail fits between the navigator and a widened render', () => {
    for (const width of ['narrow', 'comfortable'] as const) {
      for (let paneWidth = 360; paneWidth <= 3200; paneWidth += 40) {
        const { gutter, room } = roomAt(paneWidth, width)
        if (room === 0) continue
        expect(gutter - room - RAIL_MARGIN - NAVIGATOR_CLEAR).toBeGreaterThanOrEqual(STACKED_TIME)
      }
    }
  })

  test('a column that already fills the pane offers no Widen', () => {
    for (let paneWidth = 360; paneWidth <= 3200; paneWidth += 40) {
      expect(roomAt(paneWidth, 'full').room).toBe(0)
    }
    // A small pane at the comfortable width fills its width less a 2rem gutter.
    expect(roomAt(600, 'comfortable').room).toBe(0)
  })

  test('a wide pane gives the render real room to grow', () => {
    const { room } = roomAt(1600, 'comfortable')
    expect(room).toBeGreaterThan(150)
  })
})
