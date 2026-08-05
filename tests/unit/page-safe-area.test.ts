import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const renderer = join(import.meta.dir, '../../src/renderer')
const paneSource = readFileSync(join(renderer, 'components/ui/Pane.svelte'), 'utf8')
const workspaceSource = readFileSync(
  join(renderer, 'components/layout/WorkspaceBody.svelte'),
  'utf8',
)
const routeSource = readFileSync(
  join(renderer, 'contexts/workspace/routing/route-registry.ts'),
  'utf8',
)

describe('page window-control safe area', () => {
  test('reserves the contextual top inset once for every page route', () => {
    // WHY: a new page must not need a bespoke macOS traffic-light workaround.
    // The route outlet already identifies the full page group, so the invariant
    // belongs there rather than in Tasks, Settings, Folio, or future pages.
    expect(paneSource).toContain('descriptor?.exclusiveGroup === "page"')
    expect(paneSource).toContain('class="page-surface')
    expect(paneSource).toContain('descriptor?.ownsTitlebarChrome !== true')
    expect(paneSource).toContain(
      'padding-top: var(--solus-page-top-inset, 0px)',
    )
  })

  test('does not double-inset pages that own titlebar-aware chrome', () => {
    // PR Review, Task detail, and Review Mode already draw a shared 52px header with the
    // horizontal window-control safe area. Padding their route outlet by the
    // same titlebar height creates the large empty band seen above the header.
    expect(routeSource).toMatch(
      /reviewMode:\s*{[\s\S]*?exclusiveGroup:\s*'page',[\s\S]*?ownsTitlebarChrome:\s*true,/,
    )
    expect(routeSource).toMatch(
      /prReview:\s*{[\s\S]*?exclusiveGroup:\s*'page',[\s\S]*?ownsTitlebarChrome:\s*true,/,
    )
    expect(routeSource).toMatch(
      /task:\s*{[\s\S]*?exclusiveGroup:\s*'page',[\s\S]*?ownsTitlebarChrome:\s*true,/,
    )
    expect(paneSource).toContain('class:page-surface--inset={needsPageTopInset}')
  })

  test('publishes the inset only when a pane reaches the window top-left', () => {
    // A docked companion or a page beside the open session sidebar cannot hit
    // the traffic lights, so padding those surfaces would create a false band.
    expect(workspaceSource).toMatch(
      /secondary-pane-wrap--maximized[\s\S]*--solus-page-top-inset:\s*var\(--solus-titlebar-height\)/,
    )
    expect(workspaceSource).toMatch(
      /workspace-body\.sidebar-collapsed[\s\S]*--solus-page-top-inset:\s*var\(--solus-titlebar-height\)/,
    )
  })
})
