/**
 * Where a thread card sits in the margin.
 *
 * Every card wants its top on the first line of its anchor. Cards never
 * overlap, so collisions resolve downward in anchor order and a card that has
 * been pushed clear of its line draws a connector back to it. The focused card
 * wins its line outright and the others yield around it — the thread you are
 * reading is the one that has to be beside its text.
 *
 * Pure geometry: no DOM, no scroll container. The surface measures, this
 * places.
 */

/** Ideal top is the anchor's line top, lifted 2px so the card's cap height
 *  lines up with the text rather than its border. */
const ANCHOR_LIFT = 2
/** Cards never touch. */
export const MIN_GAP = 10
/** Past this much drift from its anchor, a card needs a connector to stay
 *  attached to its highlight. Below it the eye makes the link unaided. */
export const CONNECTOR_THRESHOLD = 24
/** How far a stuck card sits off the edge it is holding. */
export const STICKY_INSET = 16

export interface ThreadAnchor {
  id: string
  /** Top of the anchor's first line, in the rail's own coordinate space. */
  anchorTop: number
  /** Measured card height. */
  height: number
}

export interface RailViewport {
  top: number
  bottom: number
}

export interface RailLayout {
  /** id → placed top, in the same space as `anchorTop`. */
  tops: Map<string, number>
  /** Cards drifted far enough from their anchor to need a connector. */
  connectors: Set<string>
  /** Threads whose anchor sits above / below the visible region. */
  above: number
  below: number
  /** The nearest of those, in each direction — what an edge counter scrolls to. */
  nearestAboveId: string | null
  nearestBelowId: string | null
  /**
   * Set when the focused thread's anchor has scrolled out of the reading
   * viewport: the card holds that edge instead of leaving with its anchor, so
   * the thread you are in is never the one that disappears. At most one card
   * is ever stuck, because at most one is focused.
   */
  stickyEdge: 'top' | 'bottom' | null
}

/**
 * Place a run of cards downward from a starting offset, honouring each card's
 * ideal top where there is room for it.
 */
function packDown(items: ThreadAnchor[], from: number, tops: Map<string, number>): number {
  let cursor = from
  for (const item of items) {
    const top = Math.max(item.anchorTop - ANCHOR_LIFT, cursor)
    tops.set(item.id, top)
    cursor = top + item.height + MIN_GAP
  }
  return cursor
}

/**
 * Place a run of cards *upward* from a ceiling — used for the cards above the
 * focused one, which have to give way rather than push it off its line.
 * Walked in reverse so the card nearest the focused one yields first.
 */
function packUp(items: ThreadAnchor[], until: number, tops: Map<string, number>): void {
  let ceiling = until
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    const top = Math.min(item.anchorTop - ANCHOR_LIFT, ceiling - item.height)
    tops.set(item.id, top)
    ceiling = top - MIN_GAP
  }
}

export function layoutThreads(
  items: ThreadAnchor[],
  opts: { focusedId?: string | null; viewport?: RailViewport } = {},
): RailLayout {
  const ordered = [...items].sort((a, b) => a.anchorTop - b.anchorTop)
  const tops = new Map<string, number>()

  const focusedIndex = opts.focusedId
    ? ordered.findIndex((item) => item.id === opts.focusedId)
    : -1

  let stickyEdge: RailLayout['stickyEdge'] = null
  if (focusedIndex === -1) {
    packDown(ordered, Number.NEGATIVE_INFINITY, tops)
  } else {
    const focused = ordered[focusedIndex]
    const viewport = opts.viewport
    // A focused card whose anchor has left the viewport stops tracking it and
    // holds the edge the anchor went out of, so the thread stays readable while
    // the reader scrolls back to it.
    if (viewport && focused.anchorTop < viewport.top) stickyEdge = 'top'
    else if (viewport && focused.anchorTop > viewport.bottom) stickyEdge = 'bottom'

    const focusedTop =
      stickyEdge === 'top'
        ? viewport!.top + STICKY_INSET
        : stickyEdge === 'bottom'
          ? viewport!.bottom - STICKY_INSET - focused.height
          : focused.anchorTop - ANCHOR_LIFT
    tops.set(focused.id, focusedTop)
    packUp(ordered.slice(0, focusedIndex), focusedTop - MIN_GAP, tops)
    packDown(ordered.slice(focusedIndex + 1), focusedTop + focused.height + MIN_GAP, tops)
  }

  const connectors = new Set<string>()
  for (const item of ordered) {
    // A stuck card's anchor is off-screen, so there is nothing to draw a curve to.
    if (stickyEdge && item.id === opts.focusedId) continue
    const top = tops.get(item.id)!
    if (Math.abs(top - (item.anchorTop - ANCHOR_LIFT)) > CONNECTOR_THRESHOLD) {
      connectors.add(item.id)
    }
  }

  // Off-screen threads become a count at the edge, never a stack of cards the
  // reader has to scroll past to reach the ones they can see. The counter also
  // carries the nearest thread in its direction, so clicking it goes somewhere.
  let above = 0
  let below = 0
  let nearestAboveId: string | null = null
  let nearestBelowId: string | null = null
  if (opts.viewport) {
    for (const item of ordered) {
      // The stuck card is still on screen, so it is not one of the hidden ones.
      if (stickyEdge && item.id === opts.focusedId) continue
      if (item.anchorTop < opts.viewport.top) {
        above++
        nearestAboveId = item.id
      } else if (item.anchorTop > opts.viewport.bottom) {
        below++
        nearestBelowId ??= item.id
      }
    }
  }

  return { tops, connectors, above, below, nearestAboveId, nearestBelowId, stickyEdge }
}
