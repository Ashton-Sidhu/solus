/**
 * Bringing a card that just grew back into the transcript's viewport.
 *
 * `scrollIntoView` is not enough here: the input bar floats over the foot of
 * the scroller, so aligning a card's bottom with the scrollport's bottom parks
 * it underneath. The transcript reserves that strip as trailing space after its
 * last row, which is the same distance this leaves clear.
 */
const INPUT_BAR_CLEARANCE = 100

function scrollerFor(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement
  while (node) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/** Scroll just far enough that all of `element` sits clear of the input bar. */
export function revealInTranscript(element: HTMLElement): void {
  const scroller = scrollerFor(element)
  if (!scroller) return
  const card = element.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()

  const hidden = card.bottom - (view.bottom - INPUT_BAR_CLEARANCE)
  if (hidden <= 0) return
  // A card taller than the viewport can't be shown whole; show its top rather
  // than chasing its bottom off the other edge.
  const headroom = Math.max(0, card.top - view.top)
  scroller.scrollBy({ top: Math.min(hidden, headroom), behavior: 'smooth' })
}
