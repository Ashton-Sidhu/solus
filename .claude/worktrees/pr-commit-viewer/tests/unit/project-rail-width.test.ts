import { describe, expect, test } from 'bun:test'
import {
  isProjectRailOpen,
  PROJECT_RAIL_MAX_WIDTH,
  PROJECT_RAIL_MIN_CONTAINER_WIDTH,
  PROJECT_RAIL_MIN_WIDTH,
  projectRailWidth,
} from '../../src/renderer/components/project-panel/lib/rail-width'
import { MIN_PRIMARY_PANE_WIDTH } from '../../src/renderer/components/layout/lib/workspace-body'

// The rail is no longer draggable — it scales with the conversation view that
// owns it and minimizes itself when that view can't hold both. These tests pin
// the two properties the layout depends on: the rail never squeezes the
// conversation below its own minimum, and the visibility threshold meets the
// width floor exactly, so there is no band where the rail is "open" but too
// narrow to read.

describe('project rail width', () => {
  test('scales with the conversation view between its bounds', () => {
    const width = projectRailWidth(1200)
    expect(width).toBeGreaterThan(PROJECT_RAIL_MIN_WIDTH)
    expect(width).toBeLessThan(PROJECT_RAIL_MAX_WIDTH)
    // Wider view, wider rail — the whole point of dropping the drag handle.
    expect(projectRailWidth(1600)).toBeGreaterThan(width)
  })

  test('clamps at both ends rather than tracking the ratio forever', () => {
    expect(projectRailWidth(320)).toBe(PROJECT_RAIL_MIN_WIDTH)
    expect(projectRailWidth(6000)).toBe(PROJECT_RAIL_MAX_WIDTH)
  })

  test('threshold leaves exactly the conversation minimum beside the rail', () => {
    // The constants meet with no gap: at the threshold the rail sits at its floor
    // and the conversation at MIN_PRIMARY_PANE_WIDTH. This is why the pane's
    // minimum never had to grow to cover the rail.
    expect(PROJECT_RAIL_MIN_CONTAINER_WIDTH - projectRailWidth(PROJECT_RAIL_MIN_CONTAINER_WIDTH))
      .toBe(MIN_PRIMARY_PANE_WIDTH)
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
