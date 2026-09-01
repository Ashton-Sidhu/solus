/**
 * Where the comment composer sits: on the mark it belongs to.
 *
 * The mark's rect is in the guest's own CSS-pixel coordinates. The frame paints
 * that viewport scaled to fit the pane, so a point at guest `(x, y)` is at
 * `(x·scale, y·scale)` from the frame's top-left — the coordinate space the
 * overlay is rendered in. This maps the mark to a top-left for the popup and
 * keeps it inside the frame: below the mark when there is room, above it when
 * there is not, and never off either edge.
 */

export interface AnchorRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FrameSize {
  width: number
  height: number
}

export interface PopupSize {
  width: number
  height: number
}

export interface AnchorPosition {
  left: number
  top: number
}

const EDGE = 6
const GAP = 8

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

export function commentAnchorPosition(
  mark: AnchorRect,
  scale: number,
  frame: FrameSize,
  popup: PopupSize,
): AnchorPosition {
  const markLeft = mark.x * scale
  const markTop = mark.y * scale
  const markBottom = (mark.y + mark.height) * scale

  const left = clamp(markLeft, EDGE, frame.width - popup.width - EDGE)

  // Prefer just below the mark; if the popup would run off the bottom, flip it
  // above. A text callout is a zero-height point, so "below" is
  // `markBottom + gap`.
  const below = markBottom + GAP
  const above = markTop - popup.height - GAP
  const top =
    below + popup.height + EDGE <= frame.height
      ? below
      : clamp(above, EDGE, frame.height - popup.height - EDGE)

  return { left: Math.round(left), top: Math.round(top) }
}
