/**
 * Where a table's chrome sits, and what clicking one piece of it selects.
 *
 * Grips are 4px ink bars in the table's own gutters — no chrome, no icons —
 * and the insert tabs are two 19px circles straddling the outer border. All of
 * it is measured off the rendered table rather than computed from the doc, so
 * a table with resized columns or a horizontally scrolled wide table still gets
 * chrome that lines up with what the reader can see.
 *
 * Nothing here enters layout. Every box is in viewport coordinates and paints
 * in a fixed overlay, so the table's own box is identical whether the chrome is
 * showing or not and the prose beside it cannot shift.
 */

/** A viewport-coordinate rectangle the overlay paints an affordance in. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

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

/** A 4px ink bar. */
const GRIP_THICKNESS = 4
/**
 * The gutter each grip stands in. The column gutter clears the table's top rule
 * far enough that the block bar can sit above without covering it; the row
 * gutter clears the block drag handle, which shares that side and is 18px wide.
 */
const COLUMN_GRIP_GAP = 26
const ROW_GRIP_GAP = 22
/** The insert tabs, straddling the outer border they add against. */
const INSERT_TAB_SIZE = 19
const INSERT_TAB_OVERHANG = 11

export type ChromeKind = 'row' | 'column' | 'insert-row' | 'insert-column'

export interface ChromeAffordance {
  /** Stable across frames, so grading and painting agree on identity. */
  key: string
  kind: ChromeKind
  /** Row or column index for a grip; -1 for an insert tab, which has no index. */
  index: number
  box: Box
}

/** Every piece of chrome a table offers, in the coordinates it paints at. */
export function tableChromeAffordances(
  geometry: TableGripGeometry,
): ChromeAffordance[] {
  const { table } = geometry
  const affordances: ChromeAffordance[] = []

  for (const column of geometry.columns) {
    affordances.push({
      key: `column:${column.index}`,
      kind: 'column',
      index: column.index,
      box: {
        left: column.start,
        top: table.top - COLUMN_GRIP_GAP,
        width: Math.max(8, column.length - 6),
        height: GRIP_THICKNESS,
      },
    })
  }
  for (const row of geometry.rows) {
    affordances.push({
      key: `row:${row.index}`,
      kind: 'row',
      index: row.index,
      box: {
        left: table.left - ROW_GRIP_GAP,
        top: row.start,
        width: GRIP_THICKNESS,
        height: Math.max(8, row.length - 4),
      },
    })
  }
  affordances.push({
    key: 'insert-column',
    kind: 'insert-column',
    index: -1,
    box: {
      left: table.right + INSERT_TAB_OVERHANG - INSERT_TAB_SIZE / 2,
      top: table.top + table.height / 2 - INSERT_TAB_SIZE / 2,
      width: INSERT_TAB_SIZE,
      height: INSERT_TAB_SIZE,
    },
  })
  affordances.push({
    key: 'insert-row',
    kind: 'insert-row',
    index: -1,
    box: {
      left: table.left + table.width / 2 - INSERT_TAB_SIZE / 2,
      top: table.bottom + INSERT_TAB_OVERHANG - INSERT_TAB_SIZE,
      width: INSERT_TAB_SIZE,
      height: INSERT_TAB_SIZE,
    },
  })
  return affordances
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
