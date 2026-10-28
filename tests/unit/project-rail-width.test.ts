import { describe, expect, test } from 'bun:test'
import {
  canExpandProjectRail,
  isProjectRailOpen,
  PROJECT_RAIL_MIN_CONTAINER_WIDTH,
  PROJECT_RAIL_REVEAL_MIN_CONTAINER_WIDTH,
  projectRailWidth,
  toggleProjectRail,
} from '@solus/workspace-ui/components/project-panel/lib/rail-width'
import {
  MIN_PRIMARY_PANE_WIDTH,
  companionMinimizesProjectPanel,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@solus/workspace-ui/components/layout/lib/workspace-body'

// The rail starts as the session sidebar's twin, then accepts a manually chosen
// width from any card border. These tests pin both modes and the shared safety
// rule: it never squeezes the conversation below its minimum in a narrow split.

describe('project rail width', () => {
  test('a narrow split caps the rail at what the conversation can spare', () => {
    // WHY: sizing off the window alone breaks here. A 5K window with a narrow
    // split view would hand the rail 380px out of a 620px pane and leave the
    // conversation 240px.
    const split = MIN_PRIMARY_PANE_WIDTH + SIDEBAR_MIN_WIDTH + 40
    expect(projectRailWidth(2560, split)).toBe(split - MIN_PRIMARY_PANE_WIDTH)
    expect(split - projectRailWidth(2560, split)).toBe(MIN_PRIMARY_PANE_WIDTH)
  })

  test('uses a manually selected width within the rail constraints', () => {
    expect(projectRailWidth(1440, 1200, 340)).toBe(340)
    expect(projectRailWidth(1440, 1200, 120)).toBe(SIDEBAR_MIN_WIDTH)
    expect(projectRailWidth(1440, 1200, 520)).toBe(SIDEBAR_MAX_WIDTH)
  })

  test('keeps the conversation minimum when a manual width no longer fits', () => {
    const containerWidth = MIN_PRIMARY_PANE_WIDTH + 260
    expect(projectRailWidth(2560, containerWidth, 380)).toBe(260)
  })

  test('even the widest rail leaves 800px for the conversation when it first opens', () => {
    const atThreshold = projectRailWidth(
      PROJECT_RAIL_MIN_CONTAINER_WIDTH,
      PROJECT_RAIL_MIN_CONTAINER_WIDTH,
      SIDEBAR_MAX_WIDTH,
    )
    expect(atThreshold).toBe(SIDEBAR_MAX_WIDTH)
    expect(PROJECT_RAIL_MIN_CONTAINER_WIDTH - atThreshold).toBe(800)
  })

  test('minimizes below the threshold and opens at it', () => {
    expect(isProjectRailOpen(true, 600)).toBe(false)
    expect(isProjectRailOpen(true, 1199)).toBe(false)
    expect(isProjectRailOpen(true, 1200)).toBe(true)
  })

  test('room alone never overrides the user closing it', () => {
    expect(isProjectRailOpen(false, 2000)).toBe(false)
  })

  test('a companion draft becoming a chat keeps the primary rail open when it fits', () => {
    for (const companion of [
      { name: 'draft', params: { draftId: 'draft' } },
      { name: 'chat', params: { sessionId: 'companion-session' } },
    ] as const) {
      const minimized = companionMinimizesProjectPanel(companion)
      expect(isProjectRailOpen(true, 1200, minimized)).toBe(true)
      expect(isProjectRailOpen(false, 1200, minimized)).toBe(false)
      expect(isProjectRailOpen(true, PROJECT_RAIL_MIN_CONTAINER_WIDTH - 1, minimized)).toBe(false)
    }
  })

  test('review content still minimizes the rail and closing it restores the preference', () => {
    const minimized = companionMinimizesProjectPanel({
      name: 'review', params: { sourceTabId: 'primary-tab' },
    })
    expect(isProjectRailOpen(true, 2000, minimized)).toBe(false)
    expect(isProjectRailOpen(true, 2000, companionMinimizesProjectPanel(null))).toBe(true)
    expect(isProjectRailOpen(false, 2000, companionMinimizesProjectPanel(null))).toBe(false)
  })

  test('a rail a narrow column hid still offers its expand control', () => {
    // WHY: the preference says open, so a band that reads the preference alone
    // hides the expand control and leaves the user no way to open the rail.
    const narrow = PROJECT_RAIL_MIN_CONTAINER_WIDTH - 1
    expect(isProjectRailOpen(true, narrow)).toBe(false)
    expect(canExpandProjectRail(true, narrow, false)).toBe(true)
  })

  test('pressing the toggle in a narrow column opens the rail there', () => {
    const narrow = PROJECT_RAIL_MIN_CONTAINER_WIDTH - 1
    const opened = toggleProjectRail(true, narrow, false)
    expect(opened).toEqual({ open: true, revealed: true })
    expect(isProjectRailOpen(opened.open, narrow, false, opened.revealed)).toBe(true)
    expect(canExpandProjectRail(opened.open, narrow, opened.revealed)).toBe(false)

    // The way back out: the next press closes it and drops the reveal.
    expect(toggleProjectRail(opened.open, narrow, opened.revealed)).toEqual({
      open: false,
      revealed: false,
    })
  })

  test('an open at full width does not pin the rail when the column narrows', () => {
    const opened = toggleProjectRail(false, PROJECT_RAIL_MIN_CONTAINER_WIDTH, false)
    expect(opened).toEqual({ open: true, revealed: false })
    expect(isProjectRailOpen(opened.open, PROJECT_RAIL_MIN_CONTAINER_WIDTH - 1, false, opened.revealed)).toBe(false)
  })

  test('a column with no room for a rail offers no expand control', () => {
    const tooNarrow = PROJECT_RAIL_REVEAL_MIN_CONTAINER_WIDTH - 1
    expect(isProjectRailOpen(true, tooNarrow, false, true)).toBe(false)
    expect(canExpandProjectRail(true, tooNarrow, true)).toBe(false)
    expect(canExpandProjectRail(false, tooNarrow, false)).toBe(false)
  })

  test('a reveal never overrides a temporary minimize', () => {
    expect(isProjectRailOpen(true, PROJECT_RAIL_MIN_CONTAINER_WIDTH - 1, true, true)).toBe(false)
  })
})
