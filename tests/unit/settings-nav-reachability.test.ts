import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Settings is in `FLUSH_PAGES`, so it opens as a companion pane as well as a
// full page. Its nav rail collapses below 48rem of pane, which is only safe
// because the chip strip takes over at the same width. These tests pin the
// handover, not the styling.

const page = readFileSync(
  new URL('../../packages/workspace-ui/src/components/settings/SettingsPage.svelte', import.meta.url).pathname,
  'utf8',
)

describe('settings navigation reachability', () => {
  test('the rail and the chips hand over at the same pane width', () => {
    // WHY: two thresholds that drift apart leave a band with no navigation at
    // all, or two navigations at once. One number, quoted twice, in opposite
    // directions.
    expect(page).toContain('@max-[48rem]/pane:hidden')
    expect(page).toContain('@min-[48rem]/pane:hidden')
  })

  test('the chip strip is one definition, rendered by both layouts', () => {
    // WHY: the phone branch owned this markup. Copying it for the narrow-pane
    // case would have meant a tab added in one place and missing in the other —
    // and the copy is the one nobody opens.
    expect(page).toContain('{#snippet tabChips(')
    expect([...page.matchAll(/\{@render tabChips\(/gu)]).toHaveLength(2)
  })

  test('every destination stays reachable when the rail is gone', () => {
    // WHY: this is the rule the two tests above serve. The chips render the
    // whole `tabs` list, so a tab can never be reachable only from the rail.
    const snippet = page.slice(page.indexOf('{#snippet tabChips('))
    expect(snippet.slice(0, snippet.indexOf('{/snippet}'))).toContain('#each tabs as tab')
  })
})
