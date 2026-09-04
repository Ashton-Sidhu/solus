import { describe, expect, test } from 'bun:test'
import { hasVisibleBody } from '@solus/workspace-ui/components/pr-review/lib/activity-data'

describe('PR conversation visible body', () => {
  test('a body made only of HTML comment markers paints nothing', () => {
    // WHY: bots such as Macroscope post reviews whose whole body is a state
    // marker. The renderer hides HTML comments, so a timeline row that keeps a
    // card for that body shows an empty box under the author line.
    expect(hasVisibleBody("<!-- Macroscope's review summary starts here -->")).toBe(false)
    expect(hasVisibleBody('<!-- a -->\n\n<!-- multi\nline -->\n  ')).toBe(false)
    expect(hasVisibleBody('   \n')).toBe(false)
  })

  test('prose around a marker still counts as a body', () => {
    expect(hasVisibleBody('<!-- marker -->\nLooks good to me.')).toBe(true)
    expect(hasVisibleBody('LGTM')).toBe(true)
  })
})
