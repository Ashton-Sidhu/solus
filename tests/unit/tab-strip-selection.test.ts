import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/layout/TabStrip.svelte'),
  'utf8',
)

describe('tab strip selection', () => {
  test('selects only the conversation that is on screen', () => {
    // WHY: a restored draft can sit in front of the active tab. If the tab strip
    // still gives that hidden tab to Tabs.Root as its value, clicking the tab is
    // ignored as an already-selected value and the user cannot reveal the chat.
    expect(source).toContain('<Tabs.Root\n  value={session.onScreenTabId}')
    expect(source).not.toContain('<Tabs.Root\n  value={session.activeTabId}')
  })
})
