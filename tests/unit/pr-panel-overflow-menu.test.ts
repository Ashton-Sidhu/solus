import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL(
    '../../packages/workspace-ui/src/components/pr-review/PrPanelOverflowMenu.svelte',
    import.meta.url,
  ),
  'utf8',
)

describe('pull request panel overflow menu', () => {
  test('a second trigger click closes the open menu', () => {
    // The trigger is a custom anchor rather than a DropdownMenu.Trigger. Bits
    // UI sees its pointer-down as outside the menu and closes it before the
    // click handler runs. If that close is not prevented, the click reopens
    // the menu instead of toggling it off.
    expect(source).toContain('onclick={() => (open = !open)}')
    expect(source).toMatch(
      /onInteractOutside=\{\(event\) => \{[\s\S]*triggerEl\?\.contains\(event\.target as Node\)[\s\S]*event\.preventDefault\(\)/,
    )
  })
})
