import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

function source(relativePath: string): string {
  return readFileSync(join(import.meta.dir, '../../', relativePath), 'utf8')
}

const prsPage = source('packages/workspace-ui/src/components/prs/PrsPage.svelte')
const detailPanel = source('packages/workspace-ui/src/components/prs/PrDetailPanel.svelte')
const reviewPane = source('packages/workspace-ui/src/components/pr-review/PrReviewPane.svelte')
const panelHeader = source('packages/workspace-ui/src/components/pr-review/PrPanelHeader.svelte')

describe('PR route promotion', () => {
  test('promotes the embedded panel to the standalone review route in the same pane', () => {
    // WHY: the list panel is a quick-reading surface. Focused review must use
    // the existing route without unexpectedly moving to the leading pane.
    expect(prsPage).toContain('onOpenRoute={() => openPrRoute(openPr, openTarget)}')
    expect(prsPage).toMatch(
      /session\.enterPrReview\(pr\.number, pr\.title,[\s\S]*?target: paneId/,
    )
  })

  test('clears the embedded state before route navigation', () => {
    // WHY: returning to Pull Requests must restore the list, not mount a second
    // copy of the review that was promoted to its own route.
    expect(prsPage).toMatch(
      /function openPrRoute[\s\S]*?clearPanelState\(\);[\s\S]*?session\.enterPrReview/,
    )
  })

  test('carries the open-page action through the embedded review chrome', () => {
    expect(detailPanel).toContain('{onOpenRoute}')
    expect(reviewPane).toContain('onOpenPage={onOpenRoute}')
    expect(panelHeader).toContain('aria-label="Open pull request page"')
  })
})
