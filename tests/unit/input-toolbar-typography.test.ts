import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The composer toolbar used to scale itself with `zoom:var(--solus-font-scale)`.
// That is the wrong axis twice over: it put the row in a different coordinate
// space from the `composer` container the disclosure ladder queries, and it
// grew chrome with a preference whose whole purpose is to grow prose *relative*
// to chrome (ADR-0013, `--text-workspace-chrome` in `index.css`, which
// deliberately carries no `--solus-font-scale` factor).

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname

const bar = readFileSync(`${UI}components/input/InputBar.svelte`, 'utf8')
const toolbar = readFileSync(`${UI}components/input/InputToolbar.svelte`, 'utf8')
const theme = readFileSync(`${UI}index.css`, 'utf8')

describe('input toolbar typography', () => {
  test('neither composer branch scales itself with the text preference', () => {
    // WHY: the editor branch and the compact/pill branch both carried it.
    // Removing one leaves the same defect in the same component, and it fails
    // silently — the ladder just fires at the wrong widths.
    expect(bar).not.toContain('zoom:var(--solus-font-scale,1)')
  })

  test('the toolbar takes the workspace chrome rung', () => {
    // WHY: with `zoom` gone the row needs a declared rung, or it inherits
    // whatever the card happens to set and drifts from every other control
    // strip in the workspace.
    expect(toolbar).toContain('text-workspace-chrome')
  })

  test('the chrome rung is a rung, not a scaled body size', () => {
    // WHY: this is what makes the two tests above coherent. If someone "fixes"
    // the lost scaling by multiplying the chrome rung by the preference, the
    // coordinate-space mismatch comes straight back through a different door.
    const rung = /--text-workspace-chrome:\s*([^;]+);/u.exec(theme)
    expect(rung?.[1]).toBeDefined()
    expect(rung?.[1]).not.toContain('--solus-font-scale')
  })
})
