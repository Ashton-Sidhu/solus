/**
 * Where a dragged row or column lands, and how its siblings make room for it.
 *
 * What is dragged is not a ghost that commits on release: it follows the
 * pointer 1:1, and the bands it passes spring apart to open the slot it would
 * drop into. The geometry is measured off the rendered table, so a table with
 * uneven row heights or resized columns still opens a slot the size of the band
 * actually in flight.
 *
 * One axis at a time, and the same arithmetic for both — a row travels in y and
 * a column in x, which is the only difference between them.
 */

/** Lift, so the band in flight reads as picked up rather than selected. */
export const DRAG_LIFT_PX = 2
export const DRAG_LIFT_MS = 120
/** Siblings making room — transform only, so nothing reflows. */
export const DRAG_SPRING_MS = 180
/** The drop settles rather than snaps. */
export const DRAG_SETTLE_MS = 160
/** Below this the pointer is still deciding, and the press is a click. */
export const DRAG_THRESHOLD_PX = 3

export interface Band {
  index: number
  /** Offset of the band's leading edge along its own axis, in viewport px. */
  start: number
  /** The band's extent along that axis. */
  size: number
}

/**
 * The index the band would land on if released now.
 *
 * A band is claimed by its midpoint rather than its edges: crossing half of a
 * neighbour is what commits the swap, which is what makes a slow drag read as
 * decided rather than twitchy. `firstMovableIndex` keeps a header row out of
 * range — a header that can be dropped into the body is a table that loses its
 * head by accident.
 */
export function dropIndexFor(
  bands: Band[],
  pointer: number,
  firstMovableIndex = 0,
): number {
  const movable = bands.filter((band) => band.index >= firstMovableIndex)
  if (movable.length === 0) return firstMovableIndex
  for (const band of movable) {
    if (pointer < band.start + band.size / 2) return band.index
  }
  return movable[movable.length - 1].index
}

/**
 * Where the dragged band comes to rest, relative to where it started.
 *
 * The drop settles onto this offset before the document transaction runs, so
 * the band is already in its landing place by the time the table re-renders in
 * the new order — the commit is invisible rather than a jump.
 */
export function landingShift(bands: Band[], fromIndex: number, toIndex: number): number {
  const from = bands.find((band) => band.index === fromIndex)
  const to = bands.find((band) => band.index === toIndex)
  if (!from || !to) return 0
  if (fromIndex <= toIndex) return to.start + to.size - from.size - from.start
  return to.start - from.start
}

/**
 * How far a sibling slides while the slot is open. The band in flight is not a
 * sibling — it tracks the pointer itself — so it never takes a shift.
 */
export function siblingShift(
  index: number,
  fromIndex: number,
  toIndex: number,
  draggedSize: number,
): number {
  if (index === fromIndex || fromIndex === toIndex) return 0
  if (fromIndex < toIndex) {
    return index > fromIndex && index <= toIndex ? -draggedSize : 0
  }
  return index >= toIndex && index < fromIndex ? draggedSize : 0
}
