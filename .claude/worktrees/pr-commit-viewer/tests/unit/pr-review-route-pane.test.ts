import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(
    import.meta.dir,
    '../../src/renderer/components/pr-review/PrReviewRoutePane.svelte',
  ),
  'utf8',
)

describe('pull request review route pane', () => {
  test('uses the compact complete header in a companion pane', () => {
    // WHY: The page header needs the full leading-pane width. In a companion
    // pane it overflowed and pushed its actions out of view, so the route must
    // use the panel header that keeps the tabs and actions in the narrow band.
    expect(source).toContain('const embedded = $derived(!pane.isLeading)')
    expect(source).toContain('{embedded}')
    expect(source).toContain('fullScreen={pane.maximized}')
    expect(source).toContain('onToggleFullScreen={pane.toggleMaximize}')
  })

  test('closes a companion review without replacing it with the PR list', () => {
    // WHY: A companion pane is an interruption beside the current work. Its
    // close control must remove that pane; only the leading page goes back to
    // the pull request list.
    expect(source).toContain('onExit={embedded ? pane.close : undefined}')
  })
})
