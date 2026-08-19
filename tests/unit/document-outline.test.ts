import { describe, expect, test } from 'bun:test'
import type { Editor } from '@tiptap/core'
import {
  afterDwell,
  hasOutlineMarginRoom,
  holdsWithoutDwell,
  isOutlineOpen,
  isOutlineVisible,
  sectionJumpIndex,
  type OutlineReason,
} from '@solus/workspace-ui/components/document-shell/lib/outline'
import {
  commentMarkPositions,
  countThreadsByHeading,
} from '@solus/workspace-ui/components/comments/lib/anchors'

// The outline holds itself open for several independent reasons at once. That
// is the whole reason it is a set and not a boolean: releasing one hold must
// never close it while another still applies.

describe('outline lifecycle', () => {
  const reasons = (...list: OutlineReason[]) => new Set<OutlineReason>(list)

  test('opens at the top and closes only when every hold is gone', () => {
    expect(isOutlineOpen(reasons('top'))).toBe(true)
    expect(isOutlineOpen(reasons())).toBe(false)
  })

  test('does not flash the initial top hold in a split pane', () => {
    expect(isOutlineVisible(reasons('top'), false)).toBe(false)
    expect(isOutlineVisible(reasons('top'), true)).toBe(true)
    // Split mode still allows deliberate hover expansion.
    expect(isOutlineVisible(reasons('top', 'hover'), false)).toBe(true)
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

  test('the at-top reveal waits for a margin wide enough to hold it', () => {
    // The reveal is a margin note. A laptop-width shell, or a pane narrowed by
    // a side panel, has no gutter beside the prose for the panel to unfold
    // into, so it would cover the first lines until the reader scrolled.
    expect(hasOutlineMarginRoom(1100, false)).toBe(false)
    expect(hasOutlineMarginRoom(1280, false)).toBe(false)
    expect(hasOutlineMarginRoom(1600, false)).toBe(true)
    // A laptop display buys the margin back with a narrower measure, so a
    // laptop-width shell keeps the reveal the standard one has to give up.
    expect(hasOutlineMarginRoom(1280, true)).toBe(true)
    expect(hasOutlineMarginRoom(1100, true)).toBe(true)
    expect(hasOutlineMarginRoom(900, true)).toBe(false)
    // Before the shell is measured nothing is revealed, so a narrow document
    // never flashes the panel over its own opening lines.
    expect(hasOutlineMarginRoom(0, false)).toBe(false)
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
  test('a queued measurement ignores an editor whose schema was cleared on destroy', () => {
    const destroyedEditor = { isDestroyed: true, schema: null } as unknown as Editor

    expect(commentMarkPositions(destroyedEditor)).toEqual([])
  })

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
