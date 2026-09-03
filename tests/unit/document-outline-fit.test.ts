import { describe, expect, test } from 'bun:test'
import {
  hasOutlineMarginRoom,
  isOutlineVisible,
  type OutlineReason,
} from '@solus/workspace-ui/components/document-shell/lib/outline'

// The fit rule: the contents panel renders beside the prose or not at all.
// Overlaying the measure was the bug — the trigger moves to where there is
// room, it does not land on the text.

function reasons(...held: OutlineReason[]) {
  return new Set<OutlineReason>(held)
}

describe('contents fit rule', () => {
  test('with room beside the measure, every reason still reveals the panel', () => {
    expect(isOutlineVisible(reasons('top'), true, true)).toBe(true)
    expect(isOutlineVisible(reasons('hover'), false, true)).toBe(true)
    expect(isOutlineVisible(reasons('pinned'), false, true)).toBe(true)
  })

  test('without room, no reason reveals it — hovering the bars does nothing', () => {
    expect(isOutlineVisible(reasons('hover'), false, false)).toBe(false)
    expect(isOutlineVisible(reasons('pinned'), true, false)).toBe(false)
    expect(isOutlineVisible(reasons('top', 'hover', 'jump'), true, false)).toBe(false)
  })

  test('a split pane on a wide monitor has no room, so the header owns the contents', () => {
    // 1440 fits; the same monitor split into a ~700px pane does not.
    expect(hasOutlineMarginRoom(1440, false)).toBe(true)
    expect(hasOutlineMarginRoom(700, false)).toBe(false)
    // Under 920 the gutter is gone entirely, at either display class.
    expect(hasOutlineMarginRoom(900, true)).toBe(false)
    expect(hasOutlineMarginRoom(900, false)).toBe(false)
  })

  test('a laptop display buys the room back with a narrower measure', () => {
    expect(hasOutlineMarginRoom(1100, true)).toBe(true)
    expect(hasOutlineMarginRoom(1100, false)).toBe(false)
  })
})
