import { expect, test } from 'bun:test'
import { hasLeftPress, TOUCH_SLOP_PX } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-long-press'

test('a held finger keeps its press; a scroll ends it', () => {
  // WHY: the first version cancelled the press on any `pointermove`, and a
  // finger resting on glass emits those continuously — so the peek was
  // unreachable on the one surface it exists for. The rule has to separate a
  // hold from a scroll by distance, not by whether the pointer moved at all.
  const origin = { x: 200, y: 400 }
  expect(hasLeftPress(origin, 200, 400)).toBe(false)
  expect(hasLeftPress(origin, 203, 402)).toBe(false)
  expect(hasLeftPress(origin, 200, 400 + TOUCH_SLOP_PX)).toBe(false)
  // A scroll travels, and it must still cancel — dragging the list past a row
  // is not a request to preview that row.
  expect(hasLeftPress(origin, 200, 440)).toBe(true)
  expect(hasLeftPress(origin, 260, 400)).toBe(true)
})
