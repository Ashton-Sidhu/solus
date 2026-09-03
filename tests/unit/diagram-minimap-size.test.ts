import { describe, expect, it } from 'bun:test'

import { minimapSize } from '../../packages/workspace-ui/src/components/diagram/lib/minimap-size'

// The rule the sizing exists for: the minimap floats bottom-right and the
// control bar floats bottom-centre, so the minimap must fit in the half-board
// beside the bar. Anything wider paints over the controls.
const CONTROL_BAR_WIDTH = 320
const EDGE_INSET = 15

function clearsControlBar(boardWidth: number, minimapWidth: number): boolean {
  return minimapWidth + EDGE_INSET <= (boardWidth - CONTROL_BAR_WIDTH) / 2
}

describe('minimapSize', () => {
  it('never lets the minimap reach the control bar, at any board width', () => {
    for (let boardWidth = 300; boardWidth <= 2400; boardWidth += 1) {
      const size = minimapSize(boardWidth)
      if (size === null) continue
      expect(clearsControlBar(boardWidth, size.width)).toBe(true)
    }
  })

  it('drops the minimap once the gap beside the bar is too small to read', () => {
    // A 356px pane — the narrowest the workspace split allows — and a phone.
    expect(minimapSize(356)).toBeNull()
    expect(minimapSize(390)).toBeNull()
  })

  it('grows back to xyflow’s full 200x150 on a board wide enough for it', () => {
    expect(minimapSize(1200)).toEqual({ width: 200, height: 150 })
  })

  it('shrinks with the board between the floor and the full size', () => {
    const narrow = minimapSize(560)
    const wide = minimapSize(700)
    expect(narrow).not.toBeNull()
    expect(wide).not.toBeNull()
    expect(narrow!.width).toBeLessThan(wide!.width)
    expect(wide!.width).toBeLessThan(200)
  })

  it('keeps the 4:3 shape the minimap is drawn at', () => {
    for (const boardWidth of [560, 640, 700, 760, 1440]) {
      const size = minimapSize(boardWidth)
      expect(size).not.toBeNull()
      expect(size!.height).toBe(Math.round(size!.width * 0.75))
    }
  })

  it('assumes the wide case before the board has been measured', () => {
    expect(minimapSize(0)).toEqual({ width: 200, height: 150 })
  })
})
