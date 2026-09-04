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

  test('scales the header trigger and menu with the client display', () => {
    // WHY: the PR header is shared by the full page and the list-side panel.
    // Its overflow must follow the same 14px desktop / 12px laptop chrome rung.
    expect(source).toContain('pointer-fine:[.is-laptop-display_&]:size-6')
    expect(source).toContain('pointer-fine:[.is-laptop-display_&]:size-3.5')
    expect(source).toContain('[&_.menu-row]:text-workspace-chrome')
    expect(source).toContain('size-[max(100%,3rem)]')
  })
})
