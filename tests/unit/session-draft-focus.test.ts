import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const draftPane = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/session-draft/SessionDraftPane.svelte',
  ),
  'utf8',
)
const inputBar = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/input/InputBar.svelte',
  ),
  'utf8',
)

describe('session draft composer focus', () => {
  test('claims focus after the routed composer is visible and its picker closes', () => {
    // WHY: the draft is its own routed surface. It must address its own input
    // directly after mount instead of broadcasting to every mounted composer.
    expect(draftPane).toContain('surfaceVisible = true')
    expect(draftPane).toContain('bind:this={composerInput}')
    expect(draftPane).toMatch(
      /\$effect\(\(\) => \{[\s\S]*session\.sessionPickerOpen[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*composerInput\?\.focus\(\)/,
    )
    expect(draftPane).toContain('cancelAnimationFrame(focusFrame)')
    expect(inputBar).toMatch(/export function focus\(\) \{\s*composerEl\?\.focus\(\)/)
  })
})
