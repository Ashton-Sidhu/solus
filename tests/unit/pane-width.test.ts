import { describe, expect, test } from 'bun:test'
import {
  isCompactPane,
  isStackedPane,
  PANE_COMPACT_MAX,
  PANE_STACKED_MAX,
} from '@solus/workspace-ui/lib/pane-width'

// The few decisions CSS cannot make — PaneForge's split direction, a
// virtualiser's row height — still need a width. These pin that it is the
// pane's width and that it answers the same way the CSS rungs do.

describe('pane width rungs', () => {
  test('a pane at its floor stacks; a window-sized one does not', () => {
    // WHY: this is the defect the whole plan exists for. The primary pane is
    // legally 356px on a 1440px window, so a surface that asked the window got
    // the two-column answer inside a box that cannot hold two columns.
    expect(isStackedPane(356)).toBe(true)
    expect(isStackedPane(1440)).toBe(false)
  })

  test('zero is not narrow', () => {
    // WHY: width is 0 for the frame before the observer first reports. Calling
    // that "stacked" flashes the phone layout on every mount on a wide display.
    expect(isStackedPane(0)).toBe(false)
    expect(isCompactPane(0)).toBe(false)
  })

  test('every stacked pane is also compact, never the reverse', () => {
    // WHY: two rungs that can disagree produce a pane that stacks its columns
    // while still drawing full-width chrome.
    for (const width of [1, 100, PANE_STACKED_MAX - 1, PANE_STACKED_MAX, 600, PANE_COMPACT_MAX, 2000]) {
      if (isStackedPane(width)) expect(isCompactPane(width)).toBe(true)
    }
  })

  test('the rungs are the numbers the stylesheet uses', () => {
    // WHY: a surface that stacks at one width in CSS and another in JS has two
    // layouts and no rule. 30rem is the composer ladder's first rung; 48rem is
    // the Settings nav rail's.
    expect(PANE_STACKED_MAX).toBe(30 * 16)
    expect(PANE_COMPACT_MAX).toBe(48 * 16)
  })
})
