import { describe, expect, test } from 'bun:test'
import { atMenuFooter } from '@solus/workspace-ui/components/editor/unified-autocomplete/footer'

// WHY: when only MCP resources matched, the `@` menu's footer said "0 files".
// The count says what the menu shows, in the words the menu uses.
describe('the footer of the @ menu', () => {
  test('a menu of resources alone counts resources, never "0 files"', () => {
    expect(atMenuFooter(0, 2)).toBe('2 resources')
    expect(atMenuFooter(null, 1)).toBe('1 resource')
  })

  test('files and resources together count both', () => {
    expect(atMenuFooter(12, 3)).toBe('12 files · 3 resources')
    expect(atMenuFooter(1, 0)).toBe('1 file')
    expect(atMenuFooter(1_204, 0)).toBe('1,204 files')
  })

  test('a menu with nothing to count says nothing', () => {
    expect(atMenuFooter(0, 0)).toBe('')
    expect(atMenuFooter(null, 0)).toBe('')
  })
})
