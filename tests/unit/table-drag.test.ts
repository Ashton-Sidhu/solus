import { describe, expect, test } from 'bun:test'
import {
  dropIndexFor,
  landingShift,
  siblingShift,
  type Band,
} from '@solus/workspace-ui/components/editor/lib/table-drag'

// A dragged row or column is not a ghost: it follows the pointer, its siblings
// spring apart to open the slot, and the drop settles into the landing place
// before the document transaction runs.

const rows: Band[] = [
  { index: 0, start: 100, size: 40 },
  { index: 1, start: 140, size: 40 },
  { index: 2, start: 180, size: 60 },
  { index: 3, start: 240, size: 40 },
]

describe('table band drag', () => {
  test('a band is claimed by its midpoint, so half a neighbour commits the swap', () => {
    expect(dropIndexFor(rows, 159, 0)).toBe(1)
    expect(dropIndexFor(rows, 161, 0)).toBe(2)
  })

  test('the pointer past either end clamps rather than losing the drag', () => {
    expect(dropIndexFor(rows, -500, 0)).toBe(0)
    expect(dropIndexFor(rows, 5000, 0)).toBe(3)
  })

  test('a header row is out of range, so a table cannot lose its head by accident', () => {
    expect(dropIndexFor(rows, 105, 1)).toBe(1)
    expect(dropIndexFor(rows, -500, 1)).toBe(1)
  })

  test('only the bands between origin and target make room, and only they', () => {
    // Dragging row 0 down to row 2: 1 and 2 slide up by the dragged height.
    expect(siblingShift(1, 0, 2, 40)).toBe(-40)
    expect(siblingShift(2, 0, 2, 40)).toBe(-40)
    expect(siblingShift(3, 0, 2, 40)).toBe(0)
    // Dragging row 3 up to row 1: 1 and 2 slide down.
    expect(siblingShift(1, 3, 1, 40)).toBe(40)
    expect(siblingShift(2, 3, 1, 40)).toBe(40)
    expect(siblingShift(0, 3, 1, 40)).toBe(0)
  })

  test('the band in flight never takes a sibling shift — it tracks the pointer', () => {
    expect(siblingShift(0, 0, 2, 40)).toBe(0)
    expect(siblingShift(2, 2, 2, 40)).toBe(0)
  })

  test('the landing place is where the band comes to rest, both directions', () => {
    // Row 0 (40 tall) into slot 2: rests flush with row 2's bottom edge.
    expect(landingShift(rows, 0, 2)).toBe(180 + 60 - 40 - 100)
    // Row 3 up into slot 1: rests on row 1's leading edge.
    expect(landingShift(rows, 3, 1)).toBe(140 - 240)
    expect(landingShift(rows, 2, 2)).toBe(0)
  })
})
