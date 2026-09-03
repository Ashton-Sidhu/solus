import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The symbol card is the one popover in the workspace that opens over a surface
// which owns its own focus. Pierre's `CodeView` puts focus back on its root
// whenever it recycles a rendered item that held focus, and it does that from
// inside its render loop. Bits UI's focus trap answers a focus it did not
// authorise by pulling it back into the card. Neither yields, so the renderer
// locks on the first Cmd/Ctrl-click. The card also opens on its loading state,
// which has nothing tabbable, so the trap moves focus off the code every time —
// there is no symbol for which this is survivable.

const CARD = readFileSync(
  new URL('../../packages/workspace-ui/src/components/code-intel/CodeIntelPopover.svelte', import.meta.url),
  'utf8',
)

describe('symbol card focus', () => {
  test('does not trap focus over the code surface', () => {
    expect(CARD).toContain('trapFocus={false}')
  })
})
