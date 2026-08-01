const MAX_CONTEXT_HEIGHT = 160
const CONTEXT_VIEWPORT_RATIO = 0.25

/**
 * Place a newly mounted question below a slice of the preceding transcript.
 * Pinning the card's bottom would let a tall question consume the whole
 * viewport and make the context it asks about appear to have disappeared.
 */
export function questionAnchorScrollTop(
  scrollTop: number,
  cardTopWithinViewport: number,
  viewportHeight: number,
): number {
  const contextHeight = Math.min(
    MAX_CONTEXT_HEIGHT,
    viewportHeight * CONTEXT_VIEWPORT_RATIO,
  )
  return Math.max(0, scrollTop + cardTopWithinViewport - contextHeight)
}
