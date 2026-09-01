import { describe, expect, test } from 'bun:test'
import {
  filterCommands,
  slashMenuIsOpen,
} from '@solus/workspace-ui/components/editor/slashCommands'

// The block menu and the editor's Enter/Tab/arrow handlers must agree on one
// condition. When they disagree, a "/" token that matches no command hides the
// menu but still swallows the keys — Enter then does nothing in the document
// and plan editors.
describe('editor block menu visibility', () => {
  test('a bare slash opens the menu on the full command list', () => {
    expect(slashMenuIsOpen(true, filterCommands('').length)).toBe(true)
  })

  test('a slash token that matches no command keeps the menu closed', () => {
    // A typed path such as "/Users" — the token is live, nothing matches.
    expect(filterCommands('Users')).toHaveLength(0)
    expect(slashMenuIsOpen(true, filterCommands('Users').length)).toBe(false)
  })

  test('no live token keeps the menu closed even with matches', () => {
    expect(slashMenuIsOpen(false, filterCommands('table').length)).toBe(false)
  })
})
