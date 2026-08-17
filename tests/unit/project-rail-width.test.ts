import { describe, expect, test } from 'bun:test'
import {
  isProjectRailOpen,
  PROJECT_RAIL_MIN_CONTAINER_WIDTH,
  projectRailWidth,
} from '../../src/renderer/components/project-panel/lib/rail-width'
import {
  defaultWorkspaceRailWidth,
  MIN_PRIMARY_PANE_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../src/renderer/components/layout/lib/workspace-body'

// The rail is not draggable and no longer has a band of its own: it is the
// session sidebar's twin, so it takes the sidebar's width off the same window.
// These tests pin the two properties the layout depends on — the rail matches
// the sidebar, and it still never squeezes the conversation below its minimum
// when the view hosting it is narrower than the window (a split).

describe('project rail width', () => {
  test('matches the session sidebar on the same window', () => {
    // WHY: this is the whole rule. Two rails of different widths on one window
    // read as a layout accident, not a frame.
    for (const workspaceWidth of [1194, 1440, 1512, 1728, 2560]) {
      const roomy = workspaceWidth // no split: the view can give the full width
      expect(projectRailWidth(workspaceWidth, roomy)).toBe(
        defaultWorkspaceRailWidth(workspaceWidth),
      )
    }
  })

  test('a narrow split caps the rail at what the conversation can spare', () => {
    // WHY: sizing off the window alone breaks here. A 5K window with a narrow
    // split view would hand the rail 380px out of a 620px pane and leave the
    // conversation 240px.
    const split = PROJECT_RAIL_MIN_CONTAINER_WIDTH + 40
    expect(projectRailWidth(2560, split)).toBe(split - MIN_PRIMARY_PANE_WIDTH)
    expect(split - projectRailWidth(2560, split)).toBe(MIN_PRIMARY_PANE_WIDTH)
  })

  test('threshold leaves exactly the conversation minimum beside the rail', () => {
    // The constants meet with no gap: at the threshold the rail sits at the
    // sidebar's floor and the conversation at MIN_PRIMARY_PANE_WIDTH. This is why
    // the pane's minimum never had to grow to cover the rail.
    const atThreshold = projectRailWidth(
      PROJECT_RAIL_MIN_CONTAINER_WIDTH,
      PROJECT_RAIL_MIN_CONTAINER_WIDTH,
    )
    expect(atThreshold).toBe(SIDEBAR_MIN_WIDTH)
    expect(PROJECT_RAIL_MIN_CONTAINER_WIDTH - atThreshold).toBe(MIN_PRIMARY_PANE_WIDTH)
  })

  test('minimizes below the threshold and opens at it', () => {
    expect(isProjectRailOpen(true, PROJECT_RAIL_MIN_CONTAINER_WIDTH - 1)).toBe(false)
    expect(isProjectRailOpen(true, PROJECT_RAIL_MIN_CONTAINER_WIDTH)).toBe(true)
  })

  test('room alone never overrides the user closing it', () => {
    expect(isProjectRailOpen(false, 2000)).toBe(false)
  })

  test('secondary content minimizes the rail without changing its preference', () => {
    expect(isProjectRailOpen(true, 2000, true)).toBe(false)
    expect(isProjectRailOpen(true, 2000, false)).toBe(true)
  })
})
