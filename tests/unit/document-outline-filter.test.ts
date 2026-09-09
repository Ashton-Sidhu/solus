import { describe, expect, test } from 'bun:test'
import type { PlanHeading } from '@solus/workspace-ui/components/document-shell/headings'
import { outlineRows } from '@solus/workspace-ui/components/document-shell/lib/outline-filter'

// A long document's contents is a thing you search. These are the two rules
// that keeps it usable at a hundred headings — the filter finds a section
// wherever it sits, and the sections pin so the list always says where it is.

const heading = (level: number, text: string, pos: number): PlanHeading => ({ level, text, pos })

const doc: PlanHeading[] = [
  heading(2, 'Purpose', 10),
  heading(2, 'Technical findings', 20),
  heading(3, 'The Uplink admission bound', 30),
  heading(3, 'The existing queue and its limits', 40),
  heading(2, 'Rollout', 50),
]

const rowText = (rows: { heading: PlanHeading }[]) => rows.map((row) => row.heading.text)

describe('the outline list', () => {
  test('an empty query is not a filter, and every heading keeps its place', () => {
    const rows = outlineRows(doc, '   ')
    expect(rows.length).toBe(doc.length)
    // The index is the position in the whole document: the numeral beside a
    // row has to match the one the text hangs beside that heading.
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3, 4])
  })

  test('a sub-heading is found by name without its section being opened first', () => {
    expect(rowText(outlineRows(doc, 'queue'))).toEqual(['The existing queue and its limits'])
  })

  test('the filter ignores case and surrounding space, and can match nothing', () => {
    expect(rowText(outlineRows(doc, '  ROLL '))).toEqual(['Rollout'])
    expect(outlineRows(doc, 'zzz')).toEqual([])
  })

  test('sections pin, and a document written entirely in h3 still has some', () => {
    expect(outlineRows(doc, '').map((row) => row.isSection)).toEqual([true, true, false, false, true])
    const deep = [heading(3, 'A', 1), heading(4, 'A.1', 2)]
    expect(outlineRows(deep, '').map((row) => row.isSection)).toEqual([true, false])
  })

  test('nothing pins in a set of matches', () => {
    // A pinned match would sit above results that do not belong to it and
    // claim they do. Matches are a flat list, so they stay one.
    expect(outlineRows(doc, 'o').every((row) => !row.isSection)).toBe(true)
  })
})
