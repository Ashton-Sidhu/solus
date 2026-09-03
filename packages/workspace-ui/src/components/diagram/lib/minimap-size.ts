/**
 * How large the minimap may be on a board of a given width — or `null` when the
 * board is too narrow to carry one at all.
 *
 * The minimap floats in the bottom-right corner and the control bar floats
 * bottom-centre, so the minimap gets whatever is left of the half-board beside
 * the bar. xyflow's fixed 200x150 default only clears the bar from about 750px
 * up; below that it lands on top of the controls, which is where a diagram in a
 * companion pane or on a phone spends its whole life. Sizing it from that gap
 * keeps the space between the two constant as the board narrows.
 *
 * Width and height are props rather than CSS because the minimap's pan gesture
 * converts pointer deltas with the width it was given — a box resized in CSS
 * underneath it would pan at the wrong speed.
 */

/** The bottom-centre control bar at its widest (delete button present). */
const CONTROL_BAR_WIDTH = 320
/** xyflow's panel inset from the board edge. */
const EDGE_INSET = 15
/** xyflow's default, and the most a minimap is worth. */
const MAX_WIDTH = 200
/** Under this the graph reads as specks; drop the minimap instead. */
const MIN_WIDTH = 96
const HEIGHT_RATIO = 0.75

export interface MinimapSize {
  width: number
  height: number
}

export function minimapSize(boardWidth: number): MinimapSize | null {
  // Unmeasured (first frame, before the size binding lands): assume the common
  // wide case rather than flashing the minimap in.
  if (boardWidth === 0) return { width: MAX_WIDTH, height: MAX_WIDTH * HEIGHT_RATIO }

  const free = (boardWidth - CONTROL_BAR_WIDTH) / 2 - EDGE_INSET
  if (free < MIN_WIDTH) return null

  // Floor, not round: half a rounded-up pixel is half a pixel into the bar.
  const width = Math.floor(Math.min(MAX_WIDTH, free))
  return { width, height: Math.round(width * HEIGHT_RATIO) }
}
