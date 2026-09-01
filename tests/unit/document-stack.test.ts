import { describe, expect, test } from 'bun:test'
import {
  MAX_SHEETS,
  fanBox,
  fanMetrics,
  sheetMarks,
  sheetPlacement,
  stackKicker,
} from '@solus/workspace-ui/components/work/lib/document-stack'

describe('fan geometry', () => {
  test('the fan spreads evenly around 0° so the stack reads as several documents', () => {
    // WHY: an even spread is what says "more than one" at a glance. A fan that
    // leans one way reads as a single skewed page.
    const rotations = [0, 1, 2].map((i) => sheetPlacement(i, 3, 0).rotation)
    expect(rotations).toEqual([-6, 0, 6])
    expect(sheetPlacement(0, 1, 0).rotation).toBe(0)
  })

  test('four or more sheets shrink the paper rather than tightening the fan', () => {
    // WHY: at five names the index needs the width more than the paper does,
    // and a tighter fan stops reading as several documents at all.
    expect(fanMetrics(3).width).toBeGreaterThan(fanMetrics(5).width)
    expect(fanMetrics(5).spread).toBeGreaterThan(fanMetrics(3).spread)
  })

  test('the selected sheet comes to the front and everything else keeps its dealt z', () => {
    // WHY: selection must change a transform and a z and nothing else — the fan
    // never re-lays out, so nothing reflows when the selection moves.
    const front = sheetPlacement(1, 3, 1)
    const behind = sheetPlacement(2, 3, 1)
    expect(front.zIndex).toBeGreaterThan(behind.zIndex)
    expect(front.selected).toBe(true)
    // Its dispatch position is untouched; only the transform lifts it.
    expect(front.left).toBe(sheetPlacement(1, 3, -1).left)
    expect(front.top).toBe(sheetPlacement(1, 3, -1).top)
  })

  test('the box is sized from the final count so the card never grows as writes land', () => {
    const three = fanBox(3)
    // A sixth work adds a name to the index, never a sheet to the fan.
    expect(fanBox(9)).toEqual(fanBox(MAX_SHEETS))
    expect(three.width).toBeGreaterThan(fanMetrics(3).width)
  })
})

describe('sheet marks', () => {
  test('a heading rung and a body rung, taken from the work’s own first page', () => {
    // WHY: below 6px glyphs stop being legible as type, so the page is drawn as
    // bars — but they are the document's real lines, never a generic icon.
    const marks = sheetMarks('# Typography tokens\n\nWe ship three passes.\n')
    expect(marks.map((mark) => mark.heading)).toEqual([true, false])
    expect(marks[0].width).toBeLessThan(marks[1].width)
  })

  test('two different documents never draw the same page', () => {
    expect(sheetMarks('# Short')).not.toEqual(sheetMarks('# A considerably longer heading here'))
  })

  test('a work with nothing written yet draws no marks', () => {
    expect(sheetMarks(undefined)).toEqual([])
    expect(sheetMarks('   \n\n')).toEqual([])
  })
})

describe('stack head', () => {
  test('one type names itself; a mixed write is files', () => {
    // WHY: the head states what is in the stack and cannot state two types.
    expect(stackKicker(['doc', 'doc'])).toBe('documents')
    expect(stackKicker(['slides', 'slides'])).toBe('decks')
    expect(stackKicker(['doc', 'diagram'])).toBe('files')
    expect(stackKicker(['artifact', 'artifact'])).toBe('artifacts')
    expect(stackKicker([undefined, 'doc'])).toBe('documents')
  })
})
