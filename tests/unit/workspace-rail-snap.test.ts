import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/layout/WorkspaceBody.svelte'),
  'utf8',
)

describe('project rail motion', () => {
  test('moves the rail in one layout pass', () => {
    // WHY: SidePanel's default is a width/padding transition, which cannot reach
    // the compositor — it relayouts this whole column, transcript included, on
    // every one of its 240ms. The rail usually moves because the pane took a
    // draft, so a composer is mounting in those same frames: that overlap was
    // the stutter on Cmd+N. Measured on that interaction, 42 layout passes down
    // to 15 and 85 style-recalc passes down to 32.
    expect(source).toMatch(
      /\.project-rail :global\(\.side-panel-shell\) \{\s*transition: none;/,
    )
  })

  test('leaves the session sidebar fade alone', () => {
    // WHY: the left sidebar is a .side-panel-shell too and still fades on
    // collapse. The .project-rail scope is what keeps this rail-only, so an
    // unscoped "simplification" of the selector above is a regression.
    expect(source).toContain('class="project-rail contents"')
  })
})
