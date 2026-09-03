/**
 * The two widths a dragged column border wants to find on its own.
 *
 * A column drag is 1:1 with the pointer — the text reflows under it and the
 * neighbour absorbs the delta. Two widths are worth more than exactness,
 * though, because they are the ones a reader would otherwise chase by eye: an
 * equal share of the table, and the width the column's own content fits in.
 * Within 4px the drag lands on them instead of near them.
 */

export const SNAP_TOLERANCE_PX = 4

/** The widths a column border settles onto, nearest-first ties broken by order. */
export function columnSnapCandidates(
  tableWidth: number,
  columnCount: number,
  contentWidth: number | null,
): number[] {
  const candidates: number[] = []
  if (columnCount > 0 && tableWidth > 0) candidates.push(tableWidth / columnCount)
  if (contentWidth !== null && contentWidth > 0) candidates.push(contentWidth)
  return candidates
}

/** The candidate within tolerance, or the width the pointer actually asked for. */
export function snapWidth(
  width: number,
  candidates: number[],
  tolerance = SNAP_TOLERANCE_PX,
): number {
  let best: number | null = null
  let bestGap = tolerance
  for (const candidate of candidates) {
    const gap = Math.abs(candidate - width)
    if (gap <= bestGap) {
      best = candidate
      bestGap = gap
    }
  }
  return best ?? width
}

/**
 * The pointer position to hand the resize plugin so the column lands snapped.
 *
 * ProseMirror derives the column width from `startWidth + clientX - startX`, so
 * the snap is expressed back as the `clientX` that would have produced it. That
 * keeps one source of truth for the width: the plugin still does the resizing,
 * and undo, persistence and the neighbour's delta stay native.
 */
export function snappedClientX(
  dragging: { startX: number; startWidth: number },
  clientX: number,
  candidates: number[],
  tolerance = SNAP_TOLERANCE_PX,
): number {
  const requested = dragging.startWidth + clientX - dragging.startX
  const snapped = snapWidth(requested, candidates, tolerance)
  if (snapped === requested) return clientX
  return dragging.startX + snapped - dragging.startWidth
}
