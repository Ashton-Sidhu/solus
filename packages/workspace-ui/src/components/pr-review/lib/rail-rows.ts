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
 * The content width below which the rail has no column to sit in.
 *
 * Measured on the content box of the `@container` on `ActivityFeed`'s content
 * row — 768 for the reading column, 56 of gap and 330 for the rail is the
 * shell's whole budget, and below that something has to give.
 *
 * This is the only place the rung exists. The rail used to fold under the
 * reading column at a `@max-[1000px]` of its own while its replacement
 * appeared at a JavaScript rung of 30rem, which left every pane between the
 * two with a rail stacked under the comment composer and nothing standing in
 * for it. There is no stylesheet mirror to drift from now: above the rung the
 * rail is a column, below it the whole rail is drawn inline under the title.
 */
export const RAIL_FOLD_MAX = 1000

/** True once the rail has lost its column and moved under the title. */
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
