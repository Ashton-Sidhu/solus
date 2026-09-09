import { describe, expect, test } from 'bun:test'
import {
  SWIPE_FULL_COMMIT_RATIO,
  SWIPE_REVEAL_COMMIT_RATIO,
  swipeRelease,
} from '@solus/workspace-ui/lib/swipe-actions'

describe('swipe action release', () => {
  test('opens after one quarter of the tray instead of half of it', () => {
    // WHY: half of four controls takes too much thumb travel. One quarter is
    // about one control width, while still clearing ordinary touch drift.
    const revealWidth = 256
    const commit = revealWidth * SWIPE_REVEAL_COMMIT_RATIO
    expect(swipeRelease(commit - 1, revealWidth, 320, false, false)).toBe('closed')
    expect(swipeRelease(commit, revealWidth, 320, false, false)).toBe('revealed')
  })

  test('closes after the same travel in the opposite direction', () => {
    const revealWidth = 256
    const commit = revealWidth * SWIPE_REVEAL_COMMIT_RATIO
    expect(swipeRelease(revealWidth - commit + 1, revealWidth, 320, false, true))
      .toBe('revealed')
    expect(swipeRelease(revealWidth - commit, revealWidth, 320, false, true)).toBe('closed')
  })

  test('a status-only row always rests at the controls instead of choosing one', () => {
    // WHY: no status is universally safe. Even a long swipe only reveals the
    // choices when the host supplies no full-swipe action.
    expect(swipeRelease(256, 256, 320, false, false)).toBe('revealed')
  })

  test('a host can still opt into an explicit full-swipe action', () => {
    const width = 320
    expect(swipeRelease(width * SWIPE_FULL_COMMIT_RATIO, 204, width, true, false))
      .toBe('revealed')
    expect(swipeRelease(width * SWIPE_FULL_COMMIT_RATIO + 1, 204, width, true, false))
      .toBe('full')
    expect(swipeRelease(204, 204, width, true, true)).toBe('revealed')
  })
})
