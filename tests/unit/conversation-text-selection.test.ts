import { describe, expect, test } from 'bun:test'
import { clickEndsTextSelection } from '@solus/workspace-ui/components/conversation/lib/text-selection'

function host(selection: { isCollapsed: boolean; anchorNode: Node | null; focusNode: Node | null } | null, contains = true) {
  return {
    ownerDocument: { getSelection: () => selection as unknown as Selection | null },
    contains: () => contains,
  }
}

describe('clickEndsTextSelection', () => {
  test('an ordinary click toggles the row', () => {
    // WHY: a collapsed selection is just a caret, not a drag the user made.
    expect(clickEndsTextSelection(host({ isCollapsed: true, anchorNode: null, focusNode: null }))).toBe(false)
  })

  test('a click ending a selection inside the row withholds the toggle', () => {
    const node = {} as Node
    expect(clickEndsTextSelection(host({ isCollapsed: false, anchorNode: node, focusNode: node }))).toBe(true)
  })

  test('a selection elsewhere on the page still lets the row toggle', () => {
    const node = {} as Node
    expect(clickEndsTextSelection(host({ isCollapsed: false, anchorNode: node, focusNode: node }, false))).toBe(false)
  })

  test('no selection API is not a selection', () => {
    expect(clickEndsTextSelection(host(null))).toBe(false)
  })
})
