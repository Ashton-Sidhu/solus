import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The document header is the one row in the shell that carries both the pane's
 * floating chrome cluster (maximize, close) and the surface's own actions, and
 * the two are laid out by different mechanisms — the cluster is absolutely
 * positioned over the top-right, the actions are in flow. Everything here
 * guards the two facts that keep them apart, because both failed in the same
 * header: the reserve has to be unspendable, and the header has to be one
 * height at every pane width.
 */

const shellSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/document-shell/DocumentShell.svelte',
  ),
  'utf8',
)

/** The declarations of one CSS rule, by exact selector text. */
function ruleBody(selector: string): string {
  const at = shellSource.indexOf(`${selector} {`)
  expect(at).toBeGreaterThan(-1)
  const open = shellSource.indexOf('{', at)
  return shellSource.slice(open + 1, shellSource.indexOf('}', open))
}

describe('document header — the pane chrome cluster is never sat on', () => {
  test('the compact row reserves the cluster outside its scrollport', () => {
    const row = ruleBody('.doc-shell-toolbar-row')

    // Padding here lives *inside* the scroll region: the first time the row
    // overflows — one more verb, or the wider chip a published document
    // carries ("Update", "Upstream changed") — the reserve scrolls out of view
    // and the trailing actions come to rest under maximize and close. A margin
    // takes the room off the scrollport, so overflow cannot spend it.
    expect(row).toContain('overflow-x: auto')
    expect(row).toMatch(/margin-right:[^;]*--solus-pane-chrome-inset/)
    expect(row).not.toMatch(/padding[^;]*--solus-pane-chrome-inset/)
  })

  test('the standard header only runs where its own row fits', () => {
    // Nothing in the standard header's action cluster shrinks, so it overflows
    // rather than degrading — and overflow slides the reserve off the right
    // edge just as it does in the compact row. The rung has to sit above the
    // width that row needs; below it the compact row (which scrolls) takes
    // over. 48rem is the canonical pane rung in lib/pane-width.ts.
    expect(shellSource).toMatch(/shellWidth < 48 \* 16/)

    // …and the left cluster has to be able to yield to it. A rigid breadcrumb
    // was that cluster's real floor: 12rem that pushed the actions past the
    // pane instead of giving way to them.
    expect(ruleBody('.doc-shell-breadcrumb')).not.toContain('flex-shrink: 0')
  })
})

describe('document header — one height at every pane width', () => {
  test('the compact header keeps the standard chrome row height', () => {
    const compact = ruleBody(
      '.doc-shell-root--inline .doc-shell-toolbar--compact,\n  .doc-shell-toolbar--compact',
    )

    // `height: auto` made this row 42px against the standard header's 40px —
    // and against the mac editor's 52px titlebar, where dragging a pane past
    // the rung jumped the whole document 10px.
    expect(compact).toContain('height: var(--solus-chrome-row-h, 2.5rem)')
    expect(compact).not.toContain('height: auto')
    expect(ruleBody('.doc-shell-toolbar')).toContain(
      'height: var(--solus-chrome-row-h, 2.5rem)',
    )
  })
})
