import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const read = (path: string) => readFileSync(join(import.meta.dir, '../..', path), 'utf8')

const paneSource = read('src/renderer/components/ui/Pane.svelte')
const pageSource = read('src/renderer/components/insights/InsightsPage.svelte')
const pageSkeleton = read('src/renderer/components/insights/InsightsPageSkeleton.svelte')
const resultSkeleton = read('src/renderer/components/insights/InsightsResultSkeleton.svelte')

describe('insights loading state', () => {
  test('covers the lazy route module with the insights shell', () => {
    // WHY: Insights used to fall through to the generic "Loading…" pane, so the
    // page arrived after a blank frame and then settled into its own geometry.
    expect(paneSource).toMatch(/ref\.name === "insights"[\s\S]*<InsightsPageSkeleton \/>/)
    expect(pageSkeleton).toContain('aria-label="Loading insights"')
  })

  test('covers the first answer, and only the first', () => {
    // WHY: while the page's own query runs there is no chart and no row, and an
    // empty listing there states that the host records nothing. A re-run keeps
    // its answer on screen, so the placeholder must not replace read rows.
    // Bootstrapping, not just running: the registry and the saved queries are
    // read before any statement, so `running` alone left the real empty page
    // showing between the pane's cover and this one.
    expect(pageSource).toContain('(store.running || store.bootstrapping) && !store.result')
    expect(pageSource).toMatch(/\{#if awaitingFirstAnswer\}\s*<InsightsResultSkeleton \/>/)
  })

  test('holds the histogram and listing geometry the answer lands in', () => {
    expect(resultSkeleton).toContain('h-52 w-full items-end')
    expect(resultSkeleton).toContain('sm:h-44 sm:[@media(min-height:1000px)]:h-52')
    expect(resultSkeleton).toContain('min-h-35 flex-1')
    expect(resultSkeleton).toContain('min-h-13')
    expect(resultSkeleton).toContain('import { Skeleton } from "../ui/skeleton"')
  })

  test('keeps the placeholder bars stable between renders', () => {
    // WHY: heights redrawn per render read as live data arriving.
    expect(resultSkeleton).not.toContain('Math.random')
    expect(resultSkeleton).toContain('const BAR_HEIGHTS = [')
  })
})
