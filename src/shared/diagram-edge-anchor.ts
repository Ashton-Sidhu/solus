// Floating-edge anchoring. An edge that carries no explicit source/target handle
// must not fall back to xyflow's first-declared handle (which is always the
// node's Left side) — that points the arrow backwards whenever the target sits
// to the right/below. Instead we pick the mid-point of the side of each node
// that faces the other node, so the arrow always leaves and enters from the
// facing edge. Values are absolute (top-left origin) so they map straight onto
// xyflow's flow coordinates.

export type AnchorSide = 'left' | 'right' | 'top' | 'bottom'

export interface AnchorRect {
  x: number // absolute top-left x
  y: number // absolute top-left y
  width: number
  height: number
}

export interface EdgeAnchor {
  x: number
  y: number
  side: AnchorSide
}

// Mid-point of the side of `node` that faces `toward`'s centre. Horizontal vs
// vertical is decided by the dominant axis of the centre-to-centre vector;
// ties (|dx| === |dy|) resolve horizontal, matching the LR default layout.
export function facingAnchor(node: AnchorRect, toward: AnchorRect): EdgeAnchor {
  const ncx = node.x + node.width / 2
  const ncy = node.y + node.height / 2
  const dx = toward.x + toward.width / 2 - ncx
  const dy = toward.y + toward.height / 2 - ncy

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { x: node.x + node.width, y: ncy, side: 'right' }
      : { x: node.x, y: ncy, side: 'left' }
  }
  return dy >= 0
    ? { x: ncx, y: node.y + node.height, side: 'bottom' }
    : { x: ncx, y: node.y, side: 'top' }
}
