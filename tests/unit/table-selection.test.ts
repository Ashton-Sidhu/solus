import { describe, expect, test } from 'bun:test'
import {
  RING_FLOAT_PX,
  measureSelectionRing,
  selectedBandOf,
} from '@solus/workspace-ui/components/editor/lib/table-selection'

// One ring, whatever is selected. The rules it has to keep: a range gets a
// single ring around the whole range rather than one per cell, the hairline
// floats off the cell so it never crowds the text, and it stays inside the
// table's outer rules so a first or last row cannot ring outside the block.

const TABLE = { top: 50, left: 100, right: 400, bottom: 170 }

type Rect = { top: number; left: number; width: number; height: number }

function cell(selectorClass: string, rect: Rect) {
  return {
    selectorClass,
    getBoundingClientRect: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    }),
  }
}

/** Cells carry the class ProseMirror or `CellFocus` would have put on them. */
function fakeTable(cells: ReturnType<typeof cell>[]) {
  return {
    querySelectorAll: (selector: string) =>
      cells.filter((c) => selector.includes(c.selectorClass)),
    getBoundingClientRect: () => ({
      ...TABLE,
      width: TABLE.right - TABLE.left,
      height: TABLE.bottom - TABLE.top,
    }),
  } as unknown as HTMLTableElement
}

describe('table selection ring', () => {
  test('a caret cell rings that cell, floated off its bounds', () => {
    const ring = measureSelectionRing(
      fakeTable([cell('doc-cell-focus', { top: 90, left: 220, width: 90, height: 40 })]),
    )!
    expect(ring.left).toBe(220 - RING_FLOAT_PX)
    expect(ring.top).toBe(90 - RING_FLOAT_PX)
    expect(ring.width).toBe(90 + RING_FLOAT_PX * 2)
    expect(ring.height).toBe(40 + RING_FLOAT_PX * 2)
  })

  test('a range gets one ring around all of its cells, not one each', () => {
    const ring = measureSelectionRing(
      fakeTable([
        cell('selectedCell', { top: 90, left: 100, width: 120, height: 40 }),
        cell('selectedCell', { top: 90, left: 220, width: 90, height: 40 }),
        cell('selectedCell', { top: 130, left: 100, width: 120, height: 40 }),
        cell('selectedCell', { top: 130, left: 220, width: 90, height: 40 }),
      ]),
    )!
    expect(ring.left).toBe(100 - RING_FLOAT_PX)
    expect(ring.width).toBe(210 + RING_FLOAT_PX * 2)
    // Bottom is clamped to the table's own rule at 170, not floated past it.
    expect(ring.top).toBe(90 - RING_FLOAT_PX)
    expect(ring.height).toBe(170 - (90 - RING_FLOAT_PX))
  })

  test('the ring never floats outside the table rules it sits between', () => {
    const ring = measureSelectionRing(
      fakeTable([cell('selectedCell', { top: 50, left: 100, width: 300, height: 120 })]),
    )!
    expect(ring.top).toBe(TABLE.top)
    expect(ring.top + ring.height).toBe(TABLE.bottom)
  })

  test('a range wins over the caret cell, so the two never ring at once', () => {
    const ring = measureSelectionRing(
      fakeTable([
        cell('selectedCell', { top: 90, left: 100, width: 120, height: 40 }),
        cell('doc-cell-focus', { top: 130, left: 220, width: 90, height: 40 }),
      ]),
    )!
    expect(ring.left).toBe(100 - RING_FLOAT_PX)
    expect(ring.width).toBe(120 + RING_FLOAT_PX * 2)
  })

  test('nothing selected, and no table, ring nothing', () => {
    expect(measureSelectionRing(fakeTable([]))).toBeNull()
    expect(measureSelectionRing(null)).toBeNull()
  })
})

// The grips ask the document which band is selected rather than remembering
// what they last selected. That is what makes the second click on a grip — the
// one that opens the menu — land on the second click every time: a click in a
// cell, an undo, or a reach for another table drops the range, and the grips
// have to agree.

/** A grid whose selected cells carry the class prosemirror-tables puts on them. */
function grid(rows: number, columns: number, isSelected: (row: number, column: number) => boolean) {
  const cells = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => ({ selected: isSelected(row, column) })),
  )
  return {
    rows: cells.map((row) => ({ cells: row })),
    querySelectorAll: (selector: string) =>
      selector.includes('selectedCell') ? cells.flat().filter((cell) => cell.selected) : [],
  } as unknown as HTMLTableElement
}

describe('the selected band a grip reads back', () => {
  test('a whole row is a row band, a whole column a column band', () => {
    expect(selectedBandOf(grid(3, 4, (row) => row === 1))).toEqual({ axis: 'row', index: 1 })
    expect(selectedBandOf(grid(3, 4, (_, column) => column === 2))).toEqual({
      axis: 'column',
      index: 2,
    })
  })

  test('a partial range is no band, so its grip still selects before it opens', () => {
    expect(selectedBandOf(grid(3, 4, (row, column) => row < 2 && column < 2))).toBeNull()
    expect(selectedBandOf(grid(3, 4, (row, column) => row === 1 && column === 1))).toBeNull()
  })

  test('a caret in a cell is no band — the menu never opens on a first click', () => {
    expect(selectedBandOf(grid(3, 4, () => false))).toBeNull()
    expect(selectedBandOf(null)).toBeNull()
  })

  test('in a single-row table one cell is that cell’s column, not the row', () => {
    expect(selectedBandOf(grid(1, 3, (_, column) => column === 0))).toEqual({
      axis: 'column',
      index: 0,
    })
  })
})
