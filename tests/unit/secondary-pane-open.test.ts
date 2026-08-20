import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const rendererRoot = join(import.meta.dir, '../../packages/workspace-ui/src/components')

function readRendererFile(path: string): string {
  return readFileSync(join(rendererRoot, path), 'utf8')
}

describe('secondary pane open action', () => {
  test('every routed pane chrome can move its secondary content to the primary pane', () => {
    // WHY: maximize and close are not substitutes for navigation. Every route
    // shown beside the leading pane must give the user a direct way to move it
    // to the primary pane, without falsely describing non-page routes as pages.
    const movablePaneHosts = [
      'automations/AutomationPane.svelte',
      'conversation/SubagentHostPane.svelte',
      'plan/PlanPane.svelte',
      'pr-review/PrDiffPane.svelte',
      'work/WorkPane.svelte',
    ]

    for (const path of movablePaneHosts) {
      const source = readRendererFile(path)
      expect(source, path).toContain('<PaneChrome')
      expect(source, path).toContain('onOpenInSplit=')
    }

    for (const path of [
      'files/FileEditorHostPane.svelte',
      'files/FilesTreePane.svelte',
      'review/ReviewPane.svelte',
    ]) {
      const source = readRendererFile(path)
      expect(source, path).toContain('<PaneChrome')
      expect(source, path).not.toContain('onOpenInSplit=')
      expect(source, path).toContain('onToggleMaximize=')
    }
  })

  test('Files and Review draw their divider only in a companion pane', () => {
    // WHY: the divider is a seam between panes. In the primary pane it becomes
    // an unexplained inset border around the main content.
    expect(readRendererFile('files/FilesTreePane.svelte')).toContain(
      'bordered={!pane.isLeading}',
    )
    expect(readRendererFile('files/FileEditorHostPane.svelte')).toContain(
      'bordered={!pane.isLeading}',
    )
    expect(readRendererFile('review/ReviewPane.svelte')).toContain(
      'bordered={!pane.isLeading}',
    )
  })

  test('conversation and draft panes expose the same action in their shared header', () => {
    const conversation = readRendererFile('conversation/ConversationPane.svelte')
    const draft = readRendererFile('session-draft/SessionDraftPane.svelte')
    const breadcrumb = readRendererFile('conversation/SessionBreadcrumb.svelte')

    expect(conversation).toContain('onOpenAsPage=')
    expect(draft).toContain('onOpenAsPage=')
    expect(breadcrumb).toContain('aria-label="Open as page"')
  })

  test('every workspace page can move itself both ways between the panes', () => {
    // WHY: "open in split" and "open as page" are one control, not two
    // features. A page that can only come back from the companion pane makes
    // the split reachable by keybinding alone, and a page that can only go out
    // strands the user there. Each header below must offer the move and say
    // which way it goes, so the direction is decided by where the page sits.
    const pageHeaders = [
      'tasks/TasksPage.svelte',
      'tasks/task-page/TaskPage.svelte',
      'prs/PrsPage.svelte',
      'automations/AutomationsPage.svelte',
    ]

    for (const path of pageHeaders) {
      const source = readRendererFile(path)
      expect(source, path).toContain('onMoveAcross={pane.inPane ? pane.moveAcross : undefined}')
      expect(source, path).toContain('isLeading={pane.isLeading}')
    }

    // Insights renders its own header band rather than the shared list shell.
    const insights = readRendererFile('insights/InsightsPage.svelte')
    expect(insights).toContain('{#if pane.inPane}')
    expect(insights).toContain('onMove={pane.moveAcross}')

    // The pull request review is a page in the leading pane and a panel beside
    // the list, and its two chrome bands must both carry the move.
    const review = readRendererFile('pr-review/PrReviewPane.svelte')
    expect(review).toContain('{onMoveAcross}')
    expect(review).toContain('onMove={onMoveAcross}')
    expect(readRendererFile('pr-review/PrReviewRoutePane.svelte')).toContain(
      'onMoveAcross={pane.moveAcross}',
    )
  })

  test('one button states the direction, so no header hard-codes a single label', () => {
    // WHY: the label is the only thing that tells the user where the click
    // sends the page. Deriving it from `isLeading` in one place is what keeps
    // "Open in split" and "Open as page" from drifting apart per surface.
    const swap = readRendererFile('ui/PaneSwapButton.svelte')
    expect(swap).toContain('leadingDestination === "page"')
    expect(swap).toContain('"Move to primary pane"')
    expect(readRendererFile('ui/PaneChrome.svelte')).toContain(
      'leadingDestination="pane"',
    )

    for (const path of [
      'ui/PaneChrome.svelte',
      'ui/list-page/ListPage.svelte',
      'tasks/task-page/TaskChromeBar.svelte',
      'pr-review/PrPanelHeader.svelte',
      'insights/InsightsPage.svelte',
    ]) {
      expect(readRendererFile(path), path).toContain('<PaneSwapButton')
    }
  })
})
