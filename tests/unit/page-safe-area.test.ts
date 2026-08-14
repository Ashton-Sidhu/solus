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
const prsPageSource = readFileSync(
  join(renderer, 'components/prs/PrsPage.svelte'),
  'utf8',
)
const workspacePageSource = readFileSync(
  join(renderer, 'components/workspace/WorkspacePage.svelte'),
  'utf8',
)
const listPageSource = readFileSync(
  join(renderer, 'components/ui/list-page/ListPage.svelte'),
  'utf8',
)

describe('page window-control safe area', () => {
  test('provides one contextual top inset for page routes that need it', () => {
    // WHY: a new page must not need a bespoke macOS traffic-light workaround.
    // The route outlet already identifies the full page group, so the invariant
    // belongs there rather than in each page that does not own its chrome.
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
      /secondary-pane-content--maximized[\s\S]*--solus-page-top-inset:\s*var\(--solus-titlebar-height\)/,
    )
    expect(workspaceSource).toMatch(
      /workspace-body\.sidebar-collapsed[\s\S]*--solus-page-top-inset:\s*var\(--solus-titlebar-height\)/,
    )
  })

  test('keeps the session sidebar open for the pull requests workspace', () => {
    // WHY: Pull requests is a list workspace like Automations. Closing the
    // session sidebar also activates the titlebar inset and pushes its header
    // lower than the other workspace pages.
    const primaryReviewRule = workspaceSource.match(
      /const primaryReviewOpen[\s\S]*?\);/,
    )?.[0]

    expect(primaryReviewRule).toBeDefined()
    expect(primaryReviewRule).not.toContain('leadingRef?.name === "prs"')
  })

  test('keeps workspace page headers fixed when the sidebar is collapsed', () => {
    // WHY: Applying the window-control inset only after a sidebar collapse makes
    // the whole page jump down. These workspace lists keep one top measure.
    for (const route of ['tasks', 'prs', 'folio', 'automations']) {
      expect(routeSource).toMatch(
        new RegExp(
          `${route}:\\s*{[\\s\\S]*?exclusiveGroup:\\s*'page',[\\s\\S]*?ownsTitlebarChrome:\\s*true,`,
        ),
      )
    }
    expect(prsPageSource).not.toContain('reserveTitlebar')
    expect(workspacePageSource).not.toContain(
      'pt-[calc(var(--solus-page-top-inset',
    )
  })

  test('removes the list title when a detail panel opens beside it', () => {
    // WHY: In the narrow PR rail the title forces the controls onto a second
    // row, while the open PR already identifies the surface on the right.
    expect(listPageSource).toMatch(
      /{#if !split}\s*<div[^>]*>\s*<h1[^>]*>/,
    )
  })
})
