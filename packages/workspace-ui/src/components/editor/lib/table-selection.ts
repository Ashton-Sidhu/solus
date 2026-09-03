/**
 * Where the table's selection ring paints.
 *
 * One ring, whatever is selected: a caret in a cell rings that cell, and a cell
 * selection rings the whole range rather than each cell in it. Per-cell borders
 * inside a range read as several selections at once; the range's wash — the
 * `.selectedCell` overlay — already says which cells are in it.
 *
 * The ring floats 3px off the cell bounds so it never crowds the text, and is
 * clamped to the table's outer rules so a first or last row does not ring
 * outside the block. It is measured off the rendered cells, in viewport
 * coordinates, and paints in the chrome overlay: cell padding never changes on
 * select, and the table's box is the same selected and not.
 */

import type { Box } from './table-grips'

/** How far outside the cell bounds the hairline sits. */
export const RING_FLOAT_PX = 3

/** The cells a ring would enclose: the range if there is one, else the caret's. */
function ringedCells(table: HTMLTableElement): Element[] {
  const ranged = table.querySelectorAll('td.selectedCell, th.selectedCell')
  if (ranged.length > 0) return Array.from(ranged)
  return Array.from(table.querySelectorAll('td.doc-cell-focus, th.doc-cell-focus'))
}

export interface SelectedBand {
  axis: 'row' | 'column'
  index: number
}

/**
 * The whole row or column the current cell selection covers, if it covers one.
 *
 * The grips read this rather than remembering what they last selected: a click
 * in a cell, an undo, a caret arriving from the keyboard, or a reach for a
 * second table all drop the range, and the grips have to agree with the
 * document about that. A remembered band goes stale and makes the second click
 * — the one that opens the menu — land on the first.
 */
export function selectedBandOf(table: HTMLTableElement | null): SelectedBand | null {
  if (!table) return null
  const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>(
    'td.selectedCell, th.selectedCell',
  ))
  if (cells.length === 0) return null

  const selected = new Set<Element>(cells)
  const rows = Array.from(table.rows)

  for (const [index, row] of rows.entries()) {
    const band = Array.from(row.cells)
    if (band.length === cells.length && band.every((cell) => selected.has(cell))) {
      return { axis: 'row', index }
    }
  }
  for (let index = 0; index < (rows[0]?.cells.length ?? 0); index++) {
    const band = rows.map((row) => row.cells[index])
    if (band.length === cells.length && band.every((cell) => cell && selected.has(cell))) {
      return { axis: 'column', index }
    }
  }
  return null
}

export function measureSelectionRing(table: HTMLTableElement | null): Box | null {
  if (!table) return null
  const cells = ringedCells(table)
  if (cells.length === 0) return null

  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect()
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }
  if (!Number.isFinite(left)) return null

  const bounds = table.getBoundingClientRect()
  const floatedTop = Math.max(top - RING_FLOAT_PX, bounds.top)
  const floatedBottom = Math.min(bottom + RING_FLOAT_PX, bounds.bottom)
  return {
    left: left - RING_FLOAT_PX,
    top: floatedTop,
    width: right + RING_FLOAT_PX - (left - RING_FLOAT_PX),
    height: floatedBottom - floatedTop,
  }
}
