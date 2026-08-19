import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(
    import.meta.dir,
    '../../src/renderer/components/ui/list-page/ListPage.svelte',
  ),
  'utf8',
)

describe('split list page chrome', () => {
  test('keeps the project switcher out of the review rail', () => {
    // WHY: The narrow list is navigation for the open review. Changing project
    // there would replace the queue while the user is reading the review.
    expect(source).toMatch(
      /{#if !split[^}]*}\s*<ListProjectSwitcher[\s\S]*?\/>\s*{\/if}/,
    )
  })
})
