import { describe, expect, test } from 'bun:test'
import { needsInputSettle } from '@solus/workspace-ui/components/ui/plain-text-editor/lib/input-settle'

describe('settling the keyboard before a programmatic write', () => {
  test('a focused touch editor settles even with no IME composition open', () => {
    // WHY: iOS Safari raises no composition events for ordinary typing, so
    // CodeMirror's `composing` flag stays false while the keyboard still holds
    // the last word. Gating the blur on that flag alone let iOS put the sent
    // prompt back into the composer.
    expect(needsInputSettle({ hasFocus: true, composing: false, isTouchDevice: true })).toBe(true)
  })

  test('a desktop editor settles only for an open composition', () => {
    // WHY: a blur/refocus pair on desktop is a needless focus flicker unless
    // an IME is mid-word.
    expect(needsInputSettle({ hasFocus: true, composing: false, isTouchDevice: false })).toBe(false)
    expect(needsInputSettle({ hasFocus: true, composing: true, isTouchDevice: false })).toBe(true)
  })

  test('an unfocused editor never settles', () => {
    // WHY: with no focus there is nothing in flight, and blurring would still
    // hand focus back to a field the user had left.
    expect(needsInputSettle({ hasFocus: false, composing: true, isTouchDevice: true })).toBe(false)
  })
})
