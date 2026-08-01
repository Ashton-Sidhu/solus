import { describe, expect, test } from 'bun:test'
import { endCellsFor, measureTableGrips } from '../../src/renderer/components/editor/lib/table-grips'

// Grips are measured off the rendered table, never computed from the document:
// a table with dragged column widths, or one scrolled sideways inside its
// wrapper, still has to get bars that line up with what the reader sees.

type Rect = { top: number; left: number; width: number; height: number }

function cell(rect: Rect) {
  return { getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) }
}

function fakeTable(columnWidths: number[], rowHeights: number[]) {
  const rows = rowHeights.map((height, r) => {
    let left = 100
    const top = 50 + rowHeights.slice(0, r).reduce((sum, h) => sum + h, 0)
    const cells = columnWidths.map((width) => {
      const made = cell({ top, left, width, height })
      left += width
      return made
    })
    return { cells, getBoundingClientRect: () => ({ top, left: 100, width: 300, height, right: 400, bottom: top + height }) }
  })
  return {
    rows,
    getBoundingClientRect: () => ({ top: 50, left: 100, width: 300, height: 120, right: 400, bottom: 170 }),
  } as unknown as HTMLTableElement
}

describe('table grips', () => {
  test('a bar per row and per column, sized to what it stands for', () => {
    const geometry = measureTableGrips(fakeTable([120, 90, 90], [40, 40, 40]))!
    expect(geometry.columns.map((c) => c.length)).toEqual([120, 90, 90])
    // Columns start where their cells start — uneven widths, uneven bars.
    expect(geometry.columns.map((c) => c.start)).toEqual([100, 220, 310])
    expect(geometry.rows.map((r) => r.start)).toEqual([50, 90, 130])
  })

  test('column geometry comes off the header row the reader is looking at', () => {
    const geometry = measureTableGrips(fakeTable([200, 100], [40, 40]))!
    expect(geometry.columns).toHaveLength(2)
    expect(geometry.columns[0].length).toBe(200)
  })

  test('no table, no grips', () => {
    expect(measureTableGrips(null)).toBeNull()
  })

  test('the ends of a row are its first and last cell; of a column, top and bottom', () => {
    const table = fakeTable([100, 100, 100], [40, 40])
    const row = endCellsFor(table, 'row', 1)!
    expect(row[0]).toBe(table.rows[1].cells[0])
    expect(row[1]).toBe(table.rows[1].cells[2])

    const column = endCellsFor(table, 'column', 2)!
    expect(column[0]).toBe(table.rows[0].cells[2])
    expect(column[1]).toBe(table.rows[1].cells[2])
  })

  test('an index the table does not have yields nothing to select', () => {
    const table = fakeTable([100], [40])
    expect(endCellsFor(table, 'row', 5)).toBeNull()
    expect(endCellsFor(table, 'column', 5)).toBeNull()
  })
})
