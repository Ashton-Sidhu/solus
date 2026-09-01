/**
 * Column alignment for document tables.
 *
 * Alignment is a *column* property, not a cell one: markdown carries it in the
 * delimiter row (`:---`, `:---:`, `---:`), and the serializer takes the first
 * alignment it finds in a column and applies it to the whole thing. Setting a
 * single cell would therefore look right in the editor and come back changed,
 * so every cell in the column moves together.
 *
 * The column is read off the rendered table for the same reason the grips are
 * (see table-grips.ts): it is the one description of the table that already
 * agrees with what the reader is pointing at.
 */

import type { Editor } from '@tiptap/core'

export type CellAlign = 'left' | 'center' | 'right'

/** Left is the resting state, so the cycle starts one past it. */
const CYCLE: CellAlign[] = ['left', 'center', 'right']

export function nextAlign(current: CellAlign | null): CellAlign {
  const index = current ? CYCLE.indexOf(current) : 0
  return CYCLE[(index + 1) % CYCLE.length]
}

/** The cells above and below the caret's own, top row included. */
function columnCells(editor: Editor): HTMLTableCellElement[] {
  const node = editor.view.domAtPos(editor.state.selection.from).node
  const element = node instanceof Element ? node : node.parentElement
  const cell = element?.closest('td, th') as HTMLTableCellElement | null
  const table = cell?.closest('table')
  if (!cell || !table) return []
  const index = cell.cellIndex
  return Array.from(table.rows)
    .map((row) => row.cells[index])
    .filter((each): each is HTMLTableCellElement => !!each)
}

/** Position of the cell node itself, not of its content. */
function cellPos(editor: Editor, cell: HTMLTableCellElement): number | null {
  try {
    return editor.view.posAtDOM(cell, 0) - 1
  } catch {
    return null
  }
}

/** The alignment the column reads as today — what markdown would write out. */
export function currentColumnAlign(editor: Editor): CellAlign | null {
  for (const cell of columnCells(editor)) {
    const pos = cellPos(editor, cell)
    const align = pos === null ? null : editor.state.doc.nodeAt(pos)?.attrs.align
    if (align) return align as CellAlign
  }
  return null
}

/** Aligns every cell in the caret's column. No-op outside a table. */
export function alignColumn(editor: Editor, align: CellAlign): void {
  const cells = columnCells(editor)
  if (cells.length === 0) return

  const { tr } = editor.state
  for (const cell of cells) {
    const pos = cellPos(editor, cell)
    const node = pos === null ? null : editor.state.doc.nodeAt(pos)
    if (pos === null || !node) continue
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, align })
  }
  if (tr.docChanged) editor.view.dispatch(tr)
}
