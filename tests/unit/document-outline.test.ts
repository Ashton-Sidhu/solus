import { describe, expect, test } from 'bun:test'
import {
  afterDwell,
  holdsWithoutDwell,
  isOutlineOpen,
  sectionJumpIndex,
  type OutlineReason,
} from '../../src/renderer/components/document-shell/lib/outline'
import { countThreadsByHeading } from '../../src/renderer/components/comments/lib/anchors'

// The outline holds itself open for several independent reasons at once. That
// is the whole reason it is a set and not a boolean: releasing one hold must
// never close it while another still applies.

describe('outline lifecycle', () => {
  const reasons = (...list: OutlineReason[]) => new Set<OutlineReason>(list)

  test('opens at the top and closes only when every hold is gone', () => {
    expect(isOutlineOpen(reasons('top'))).toBe(true)
    expect(isOutlineOpen(reasons())).toBe(false)
  })

  test('a pin survives the pointer leaving', () => {
    // Hover ends, the dwell fires, and the pin is still holding.
    expect(afterDwell(reasons('pinned', 'jump'))).toEqual(reasons('pinned'))
    expect(isOutlineOpen(afterDwell(reasons('pinned', 'jump')))).toBe(true)
  })

  test('the top hold survives dwell while transient holds clear', () => {
    expect(afterDwell(reasons('top', 'jump'))).toEqual(reasons('top'))
    // Keyboard focus is sticky: tabbing into the outline must not have it
    // dissolve under the caret two seconds later.
    expect(holdsWithoutDwell(reasons('focus'))).toBe(true)
    expect(holdsWithoutDwell(reasons('top', 'jump'))).toBe(true)
  })

  test('⌥n only claims digits the document actually has sections for', () => {
    expect(sectionJumpIndex('Digit1', 5)).toBe(0)
    expect(sectionJumpIndex('Digit5', 5)).toBe(4)
    // A three-heading document leaves ⌥7 to whatever else wants it.
    expect(sectionJumpIndex('Digit7', 3)).toBeNull()
    expect(sectionJumpIndex('Digit0', 5)).toBeNull()
    expect(sectionJumpIndex('KeyA', 5)).toBeNull()
  })
})

describe('thread counts per section', () => {
  test('a thread belongs to the last heading above it', () => {
    const counts = countThreadsByHeading(
      [
        { id: 'a', pos: 40 },
        { id: 'b', pos: 55 },
        { id: 'c', pos: 300 },
      ],
      [30, 120, 280],
    )
    expect(counts.get(30)).toBe(2)
    expect(counts.get(280)).toBe(1)
    expect(counts.has(120)).toBe(false)
  })

  test('a thread above the first heading belongs to no section', () => {
    // The lead paragraph is not "in" section 01 — counting it there would put
    // a number beside a heading the reader never scrolled to.
    const counts = countThreadsByHeading([{ id: 'a', pos: 5 }], [30, 120])
    expect(counts.size).toBe(0)
  })
})
