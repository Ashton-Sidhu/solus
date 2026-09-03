import { describe, expect, test } from 'bun:test'
import {
  measureTableGrips,
  tableChromeAffordances,
} from '@solus/workspace-ui/components/editor/lib/table-grips'
import {
  columnSnapCandidates,
  snappedClientX,
} from '@solus/workspace-ui/components/editor/lib/table-resize-snap'

// Two rules hold the document still while a table is handled.
//
// Nothing that appears on hover may occupy layout space — grips and insert tabs
// are measured in viewport coordinates and painted in a fixed overlay, so the
// table's own box is identical hovered and unhovered and the prose beside it
// cannot shift. And a column drag is 1:1 with the pointer: the width it asks
// for is the width it gets, except within a few pixels of a snap point.

type Rect = { top: number; left: number; width: number; height: number }

function cell(rect: Rect) {
  return {
    getBoundingClientRect: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    }),
  }
}

function fakeTable(columnWidths: number[], rowHeights: number[]) {
  const width = columnWidths.reduce((sum, w) => sum + w, 0)
  const height = rowHeights.reduce((sum, h) => sum + h, 0)
  const rows = rowHeights.map((rowHeight, r) => {
    let left = 100
    const top = 50 + rowHeights.slice(0, r).reduce((sum, h) => sum + h, 0)
    const cells = columnWidths.map((columnWidth) => {
      const made = cell({ top, left, width: columnWidth, height: rowHeight })
      left += columnWidth
      return made
    })
    return {
      cells,
      getBoundingClientRect: () => ({
        top,
        left: 100,
        width,
        height: rowHeight,
        right: 100 + width,
        bottom: top + rowHeight,
      }),
    }
  })
  return {
    rows,
    getBoundingClientRect: () => ({
      top: 50,
      left: 100,
      width,
      height,
      right: 100 + width,
      bottom: 50 + height,
    }),
  } as unknown as HTMLTableElement
}

describe('document surface stability', () => {
  test('grips live in the gutters, so none of them can displace a cell', () => {
    const geometry = measureTableGrips(fakeTable([120, 90, 90], [40, 40, 40]))!
    const box = geometry.table

    for (const affordance of tableChromeAffordances(geometry)) {
      if (affordance.kind !== 'row' && affordance.kind !== 'column') continue
      const inside =
        affordance.box.left + affordance.box.width > box.left &&
        affordance.box.left < box.right &&
        affordance.box.top + affordance.box.height > box.top &&
        affordance.box.top < box.bottom
      expect(inside).toBe(false)
    }
  })

  test('each insert tab straddles the outer border it adds against', () => {
    const geometry = measureTableGrips(fakeTable([120, 90, 90], [40, 40, 40]))!
    const box = geometry.table
    const affordances = tableChromeAffordances(geometry)

    const addRow = affordances.find((a) => a.kind === 'insert-row')!
    expect(addRow.box.top).toBeLessThan(box.bottom)
    expect(addRow.box.top + addRow.box.height).toBeGreaterThan(box.bottom)

    const addColumn = affordances.find((a) => a.kind === 'insert-column')!
    expect(addColumn.box.left).toBeLessThan(box.right + addColumn.box.width)
    expect(addColumn.box.left).toBeGreaterThanOrEqual(box.right)
  })

  test('a table offers a grip per band plus the two insert tabs, and nothing else', () => {
    const geometry = measureTableGrips(fakeTable([120, 90, 90], [40, 40, 40]))!
    const kinds = tableChromeAffordances(geometry).map((a) => a.kind)
    expect(kinds.filter((kind) => kind === 'row')).toHaveLength(3)
    expect(kinds.filter((kind) => kind === 'column')).toHaveLength(3)
    expect(kinds.filter((kind) => kind === 'insert-row')).toHaveLength(1)
    expect(kinds.filter((kind) => kind === 'insert-column')).toHaveLength(1)
  })

  test('a column drag is 1:1 with the pointer away from a snap point', () => {
    const dragging = { startX: 400, startWidth: 180 }
    const candidates = columnSnapCandidates(600, 3, 240)
    // 430 asks for 210 — clear of both the 200 equal share and the 240 fit.
    expect(snappedClientX(dragging, 430, candidates)).toBe(430)
  })

  test('within tolerance the drag lands on an equal share or a content fit', () => {
    const dragging = { startX: 400, startWidth: 180 }
    // Three columns across 600px: an equal share is 200.
    const candidates = columnSnapCandidates(600, 3, 240)
    // 418 asks for 198 — inside the tolerance of the equal share.
    expect(snappedClientX(dragging, 418, candidates)).toBe(420)
    // 462 asks for 242 — inside the tolerance of the content fit.
    expect(snappedClientX(dragging, 462, candidates)).toBe(460)
    // Past the tolerance the width is the reader's own, untouched.
    expect(snappedClientX(dragging, 414, candidates)).toBe(414)
  })

  test('a column with no measurable content still snaps to the equal share', () => {
    expect(columnSnapCandidates(600, 3, null)).toEqual([200])
    expect(columnSnapCandidates(0, 0, null)).toEqual([])
  })
})
