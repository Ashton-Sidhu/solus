import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../..')
const toolbarSource = readFileSync(
  join(root, 'src/renderer/components/diff/DiffToolbar.svelte'),
  'utf8',
)
const reviewPaneSource = readFileSync(
  join(root, 'src/renderer/components/pr-review/PrReviewPane.svelte'),
  'utf8',
)
const diffPaneSource = readFileSync(
  join(root, 'src/renderer/components/pr-review/PrDiffPane.svelte'),
  'utf8',
)

describe('diff toolbar under a host header', () => {
  test('the PR review surface declares its own header above the toolbar', () => {
    // WHY: the review panel already states `#47 head → base` and floats its own
    // maximize/close in that row. Without the flag the toolbar draws a second
    // full chrome row: branch identity twice over, and a right-hand gutter
    // reserved for pane controls that are not there.
    expect(reviewPaneSource).toContain('hasHostHeaderRow={!headless}')
    // The popped-out pane is the opposite case — PaneChrome hovers over the
    // toolbar's own row there, so the gutter and chrome-row height must stay.
    expect(diffPaneSource).not.toContain('hasHostHeaderRow')
    expect(diffPaneSource).toContain('<PaneChrome')
  })

  test('the second row drops the window and pane chrome gutters', () => {
    const subrow = toolbarSource.match(/\.diff-toolbar\.is-subrow\s*{[^}]*}/)?.[0]
    expect(subrow).toBeDefined()
    expect(subrow).not.toContain('--solus-pane-chrome-inset')
    expect(subrow).not.toContain('--solus-chrome-lead-inset')
    expect(subrow).not.toContain('--solus-chrome-row-h')
    // A quieter row than the chrome band above it, not a peer of it: shorter,
    // and with no hairline of its own under the host header's rule.
    expect(subrow).toContain('min-height: 2.25rem')
    expect(subrow).toContain('border-bottom: 0')
  })

  test('the branch identity is stated once', () => {
    expect(toolbarSource).toContain('{#if !hasHostHeaderRow}')
    const identity = toolbarSource.indexOf('<GitBranchIcon')
    const guard = toolbarSource.indexOf('{#if !hasHostHeaderRow}')
    expect(guard).toBeGreaterThan(-1)
    expect(identity).toBeGreaterThan(guard)
  })
})
