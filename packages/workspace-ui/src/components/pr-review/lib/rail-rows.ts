import type { ChangedFileStat } from '@solus/contracts/types'
import { dirName } from './activity-data'

/**
 * Row geometry for the rail's two virtualized sections.
 *
 * A virtual list positions rows from a number it is told, not from what the
 * DOM measures. If the two disagree the rows overlap or leave gaps, and
 * nothing in the build or the type system catches it — so the number declared
 * here is the *only* height, applied to the row through the `style` the list
 * hands back. Never set a height on the row itself as well.
 *
 * Heights follow the display for the same reason the review's type rungs do
 * (ADR-0010/0013): the rail is narrower on a laptop and spends height it
 * cannot recover.
 */
export const CHECK_ROW_HEIGHT = { standard: 30, laptop: 28 } as const

/**
 * The content width at which the rail stops fitting beside the reading column
 * and folds under it, full width.
 *
 * Mirrors the `@max-[1000px]` on `PrActivityRail`'s root, against the
 * `@container` on `ActivityFeed`'s content row. It is duplicated here because
 * a Tailwind arbitrary value cannot read a constant, and it is a constant
 * because two things have to agree about it: below this width the readiness
 * card leaves the rail for `PrMergeBar`, which is the only reason a folded rail
 * is acceptable at all. Change one, change both — `pr-rail-fold.test.ts` fails
 * if they drift.
 */
export const RAIL_FOLD_MAX = 1000

/** True once the rail has folded under the reading column. */
export function isRailFolded(contentWidth: number): boolean {
  // Width 0 is the frame before the observer reports; answering "folded" then
  // would flash the bottom bar on every mount on a wide display.
  return contentWidth > 0 && contentWidth <= RAIL_FOLD_MAX
}

/** A changed-file row is two lines — filename over directory — unless the file
 *  sits at the repository root and has no directory to put under it. */
export const FILE_ROW_HEIGHT = {
  standard: { nested: 44, root: 30 },
  laptop: { nested: 40, root: 28 },
} as const

/** How many rows a section shows before it becomes its own scrollport. */
export const CHECKS_VISIBLE_ROWS = 6
export const FILES_VISIBLE_ROWS = 7

export function checkRowHeight(isLaptopDisplay: boolean): number {
  return isLaptopDisplay ? CHECK_ROW_HEIGHT.laptop : CHECK_ROW_HEIGHT.standard
}

export function fileRowHeight(file: ChangedFileStat, isLaptopDisplay: boolean): number {
  const scale = isLaptopDisplay ? FILE_ROW_HEIGHT.laptop : FILE_ROW_HEIGHT.standard
  return dirName(file.path) ? scale.nested : scale.root
}

/**
 * The height the section's scrollport takes: its whole content while it is
 * short, and `maxRows` rows *plus half of the next one* once it is not.
 *
 * The half row is load-bearing. The rail's virtual lists hide their scrollbars
 * (VirtualList pins `scrollbar-width: none`), so a viewport cut to a whole
 * number of rows gives a reader no signal at all that there is more below — the
 * list just appears to end. A row sliced by the fold is the one cue that
 * survives a hidden scrollbar.
 */
export function listViewportHeight(rowHeights: number[], maxRows: number): number {
  const total = rowHeights.reduce((sum, height) => sum + height, 0)
  if (rowHeights.length <= maxRows) return total
  const shown = rowHeights.slice(0, maxRows).reduce((sum, height) => sum + height, 0)
  return shown + Math.round(rowHeights[maxRows] / 2)
}
