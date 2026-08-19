/**
 * Where a table's row and column grips sit, and what clicking one selects.
 *
 * Grips are 4px ink bars in the table's own gutters — no chrome, no icons.
 * They are measured off the rendered table rather than computed from the doc,
 * so a table with resized columns or a horizontally scrolled wide table still
 * gets bars that line up with what the reader can see.
 */

export interface GripRect {
  /** Index of the row / column the bar stands for. */
  index: number
  /** Offset along the table's edge, in viewport coordinates. */
  start: number
  length: number
}

export interface TableGripGeometry {
  table: DOMRect
  rows: GripRect[]
  columns: GripRect[]
}

/** The `<tr>` elements of a table, header row included. */
function rowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.rows)
}

export function measureTableGrips(table: HTMLTableElement | null): TableGripGeometry | null {
  if (!table) return null
  const rows = rowsOf(table)
  if (rows.length === 0) return null
  const tableRect = table.getBoundingClientRect()

  const rowGrips: GripRect[] = rows.map((row, index) => {
    const rect = row.getBoundingClientRect()
    return { index, start: rect.top, length: rect.height }
  })

  // Columns are measured off the first row: every row has the same column
  // edges, and the header is the row a reader is looking at when they reach
  // for a column grip.
  const columnGrips: GripRect[] = Array.from(rows[0].cells).map((cell, index) => {
    const rect = cell.getBoundingClientRect()
    return { index, start: rect.left, length: rect.width }
  })

  return { table: tableRect, rows: rowGrips, columns: columnGrips }
}

/**
 * The cell elements at each end of a row or column — the two the editor needs
 * to resolve into a cell selection.
 */
export function endCellsFor(
  table: HTMLTableElement,
  axis: 'row' | 'column',
  index: number,
): [HTMLTableCellElement, HTMLTableCellElement] | null {
  const rows = rowsOf(table)
  if (axis === 'row') {
    const cells = rows[index]?.cells
    if (!cells || cells.length === 0) return null
    return [cells[0], cells[cells.length - 1]]
  }
  const first = rows[0]?.cells[index]
  const last = rows[rows.length - 1]?.cells[index]
  if (!first || !last) return null
  return [first, last]
}
