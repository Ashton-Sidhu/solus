/**
 * How wide a floating thread card is, in pane pixels. The open thread and the
 * composer share it so posting a comment swaps one card for another in place,
 * and it is wide enough that writing a comment does not feel like typing in a
 * pin.
 */
export const THREAD_CARD_WIDTH = 400

/** Where the floating thread card lands, in pane coordinates. */
export interface ThreadCardPlacement {
  left: number
  top: number
  /** True when the card had to leave its pin behind to stay on screen. */
  detached: boolean
}

export interface ThreadCardAnchor {
  /** Right edge and top of the anchor's rect, already in pane coordinates. */
  x: number
  y: number
}

export interface ThreadCardBox {
  width: number
  height: number
}

export interface PlaceThreadCardArgs {
  anchor: ThreadCardAnchor
  card: ThreadCardBox
  pane: ThreadCardBox
  /** Width the inspector (or its collapsed rail) claims on the right; 0 when neither is up. */
  inspectorFootprint: number
  inset?: number
  /** Gap between the anchor's edge and the card. */
  gap?: number
}

/**
 * The card floats beside its pin, never docks, and never pushes the graph — so
 * it has to fit itself into whatever the pin left over. It prefers the right of
 * the anchor, flips left when the inspector or the pane edge is in the way, and
 * clamps into the pane as a last resort. A card that had to be clamped away
 * from its anchor reports `detached`, which is what earns the pin a leader dot.
 */
export function placeThreadCard({
  anchor,
  card,
  pane,
  inspectorFootprint,
  inset = 16,
  gap = 14,
}: PlaceThreadCardArgs): ThreadCardPlacement {
  const rightLimit = pane.width - Math.max(inspectorFootprint, inset) - card.width
  const bottomLimit = pane.height - inset - card.height

  const preferred = anchor.x + gap
  const flipped = anchor.x - gap - card.width
  // Flipping is only an improvement while the left side actually has the room —
  // on a narrow pane both sides overflow and clamping is the honest answer.
  const left = preferred <= rightLimit ? preferred : flipped >= inset ? flipped : rightLimit

  const clampedLeft = Math.min(Math.max(left, inset), Math.max(rightLimit, inset))
  const clampedTop = Math.min(Math.max(anchor.y, inset), Math.max(bottomLimit, inset))

  return {
    left: clampedLeft,
    top: clampedTop,
    detached: clampedLeft !== left || clampedTop !== anchor.y,
  }
}
