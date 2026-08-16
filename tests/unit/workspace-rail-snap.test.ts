import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/layout/WorkspaceBody.svelte'),
  'utf8',
)

describe('project rail motion', () => {
  test('moves the rail silently unless the user is moving it', () => {
    // WHY: the rail closes by rule when the pane takes a draft, and the composer
    // mounts in those same frames. Animating the rail's width there re-runs
    // style and layout for the whole workspace on every frame of the 240ms,
    // which is the stutter on Cmd+N. Measured on the same interaction: 85
    // style-recalc passes down to 42, and 42 layout passes down to 22.
    expect(source).toMatch(
      /\.workspace-body:not\(\.rail-animating\) \.project-rail :global\(\.side-panel-shell\) \{\s*transition: none;/,
    )
    expect(source).toContain('class:rail-animating={railAnimating}')
  })

  test('animates the move the user asked for', () => {
    // WHY: ⌥M and the chrome button are requests to watch the rail move, so the
    // transition is armed for exactly as long as that move takes.
    expect(source).toMatch(/function toggleProjectPanel\([^)]*\) \{\s*animateRailMove\(\);/)
  })

  test('leaves the session sidebar fade alone', () => {
    // WHY: the left sidebar is a .side-panel-shell too, and it fades on collapse.
    // Scoping to .project-rail is what keeps this rail-only.
    expect(source).toContain('class="project-rail contents"')
  })
})
