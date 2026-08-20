import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const workspaceSource = (path: string) =>
  readFileSync(new URL(`../../packages/workspace-ui/src/${path}`, import.meta.url), 'utf8')

describe('laptop typography surfaces', () => {
  test('toasts inherit the canonical responsive workspace rung', () => {
    const css = workspaceSource('index.css')

    expect(css).toContain('[data-sonner-toast][data-sonner-toast]')
    expect(css).toContain('font-size: var(--text-workspace-chrome)')
  })

  test('action orb labels use the selected interface font weight', () => {
    // WHY: the action orb keeps its purpose-built responsive sizing, but its
    // labels must not become heavier than other actions for the selected font.
    const css = workspaceSource('components/layout/ActionOrb.css')

    expect(css).toMatch(
      /\.dock-btn \{[\s\S]*?font-weight: var\(--font-weight-secondary\)/,
    )
  })

  test('both slash command menus inherit responsive workspace type', () => {
    const composerMenu = workspaceSource('components/input/UnifiedAutocompleteMenu.svelte')
    const documentMenu = workspaceSource('components/editor/EditorSlashMenu.svelte')

    expect(composerMenu).toContain('unified-menu text-workspace-chrome')
    expect(documentMenu).toContain('slash-block-menu text-workspace-chrome')
  })

  test('breadcrumb and command-palette section labels use the shelf rung', () => {
    const breadcrumb = workspaceSource('components/conversation/SessionBreadcrumb.svelte')
    const commandPalette = workspaceSource('components/command-palette/CommandPalette.svelte')

    expect(breadcrumb).toContain('text-chrome-shelf font-medium')
    expect(commandPalette).toContain('[&_[data-command-group-heading]]:text-chrome-shelf')
  })

  test('review guide text inherits responsive type and its tab has no ready decoration', () => {
    const guide = workspaceSource('components/pr-review/guide/GuideView.svelte')
    const tabs = workspaceSource('components/review/ReviewViewTabs.svelte')

    expect(guide).toContain('class="text-workspace-chrome relative')
    expect(guide).toContain('prose-review-guide')
    expect(tabs).not.toContain('SparkleIcon')
    expect(tabs).not.toContain('>Ready</span>')
  })

  test('conversation messages wrap earlier on laptop displays', () => {
    const conversation = workspaceSource('components/conversation/ConversationView.svelte')
    const userMessage = workspaceSource('components/conversation/UserMessageBubble.svelte')

    expect(conversation).toContain('prose-transcript-main')
    expect(workspaceSource('index.css')).toContain(
      'html.is-laptop-display .prose-transcript-main { max-width: 82%; }',
    )
    expect(userMessage).toContain(
      'pointer-fine:[.is-laptop-display_&]:max-w-[36rem]',
    )
  })

  test('primary conversation text stays on the readable body rung', () => {
    // WHY: desktop laptop displays start at 90% zoom. A 14px transcript rung
    // therefore rendered at 12.6px, which is too small for the main user and
    // assistant messages.
    const css = workspaceSource('index.css')
    expect(css).toMatch(/\.prose-transcript \{[\s\S]*?font-size: var\(--text-body\)/)
    expect(css).toMatch(/\.prose-transcript-user \{[\s\S]*?font-size: var\(--text-body\)/)
    expect(css).toMatch(/\.pill-shell \.prose-reading \{[\s\S]*?font-size: var\(--text-body\)/)
    // WHY: tables contain dense, aligned data and must remain visibly smaller
    // than the assistant's primary prose instead of approaching the body rung.
    expect(css).toMatch(
      /\.prose-transcript table \{[\s\S]*?font-size: calc\(0\.875rem \* var\(--solus-font-scale, 1\)\)/,
    )
    expect(css).toMatch(
      /\.prose-transcript td \{[\s\S]*?padding: 0\.5rem 0\.625rem 0\.5rem 0/,
    )
  })

  test('the prompt composer matches the surrounding workspace chrome', () => {
    // WHY: the composer is an input control, not transcript reading content.
    // Giving it the body rung makes its empty-state hint visibly larger than
    // the controls that frame it, especially on laptop displays.
    const inputBar = workspaceSource('components/input/InputBar.svelte')

    expect(inputBar).toContain(
      '[--plain-editor-font-size:var(--text-workspace-chrome)]',
    )
  })

  test('Insights chrome follows its compact responsive rung', () => {
    // WHY: Insights previously mixed fixed 10px, 11px, 12px, and 13px labels.
    // Its query controls and result lists must match the 12px desktop and 10px
    // laptop Insights contract instead of setting local sizes.
    const surfaces = [
      'components/insights/InsightsPage.svelte',
      'components/insights/QueryConsole.svelte',
      'components/insights/TimeRangePicker.svelte',
      'components/insights/SqlEditor.svelte',
      'components/insights/TurnList.svelte',
      'components/insights/EventList.svelte',
      'components/insights/ResultTable.svelte',
      'components/insights/InsightsRail.svelte',
      'components/insights/TurnDetailPanel.svelte',
      'components/insights/SessionSummary.svelte',
      'components/insights/TurnToolTotals.svelte',
      'components/insights/data-table/DataTableToolbar.svelte',
      'components/insights/data-table/DataTablePagination.svelte',
      'components/insights/data-table/DataTableColumnsMenu.svelte',
      'components/insights/data-table/DataTableEmptyState.svelte',
    ]

    for (const path of surfaces) {
      expect(workspaceSource(path)).toContain('text-insights-chrome')
    }

    const queryConsole = workspaceSource('components/insights/QueryConsole.svelte')
    expect(queryConsole).not.toMatch(/text-\[(?:0\.625|0\.6875|0\.8125)rem\]/)

    const css = workspaceSource('index.css')
    expect(css).toContain('--text-insights-chrome: 0.75rem')
    expect(css).toMatch(
      /html\.is-laptop-display \{[\s\S]*?--text-insights-chrome: 0\.625rem/,
    )
  })

  test('Insights charts use the readable detail rung', () => {
    // WHY: chart labels carry the same measured values as the detail rows. They
    // and their headings stay at 14px/12px instead of shrinking to chrome.
    for (const path of [
      'components/insights/VolumeChart.svelte',
      'components/insights/SessionContextChart.svelte',
      'components/insights/ResultRankingChart.svelte',
      'components/insights/ResultTrendChart.svelte',
    ]) {
      expect(workspaceSource(path)).toContain('text-insights-summary')
    }

    expect(workspaceSource('components/insights/VolumeChart.svelte')).toContain(
      '<h2 class="text-insights-summary font-semibold">',
    )
    expect(workspaceSource('components/insights/SessionContextChart.svelte')).toContain(
      '<h2 class="m-0 text-insights-summary font-medium">',
    )
    expect(workspaceSource('components/insights/InsightsPage.svelte')).toContain(
      '<h2 class="text-insights-summary font-semibold">',
    )
  })
})
