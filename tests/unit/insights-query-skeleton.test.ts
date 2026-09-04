import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Insights query loading state', () => {
  test('every in-flight answer replaces the chart and listing with the result skeleton', () => {
    // WHY: changing query state before the result arrives can temporarily draw
    // the old page as one large spike. The loading state must cover both the
    // initial answer and every later query.
    const page = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/components/insights/InsightsPage.svelte'),
      'utf8',
    )

    expect(page).toContain('const awaitingAnswer = $derived(store.running || store.bootstrapping);')
    expect(page).toContain('{#if awaitingAnswer}\n      <InsightsResultSkeleton />')
    expect(page).not.toContain('awaitingFirstAnswer')
  })

  test('the chart placeholder uses the real histogram’s fine bar density', () => {
    // WHY: twelve wide columns look like a ranking chart, not the responsive
    // time histogram they replace. The skeleton keeps thin bars on wide panes
    // and removes bars at the same broad pane-width rungs as the real chart.
    const skeleton = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/components/insights/InsightsResultSkeleton.svelte'),
      'utf8',
    )

    expect(skeleton).toContain('{ length: 80 }')
    expect(skeleton).toContain('gap-0.5')
    expect(skeleton).toContain("'@max-[70rem]/pane:hidden'")
    expect(skeleton).toContain("'@max-[30rem]/pane:hidden'")
  })
})
