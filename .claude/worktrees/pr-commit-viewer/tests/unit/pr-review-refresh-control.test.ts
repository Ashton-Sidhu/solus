import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(
    import.meta.dir,
    '../../src/renderer/components/pr-review/PrReviewPane.svelte',
  ),
  'utf8',
)

describe('pull request review refresh control', () => {
  test('keeps a visible refresh action in the page and embedded panel headers', () => {
    // WHY: Refresh was available only in the Activity overflow menu. The review
    // header must keep the action visible in both shapes of the PR surface.
    expect(source.match(/{@render refreshButton\(\)}/g)).toHaveLength(2)
    expect(source).toContain('aria-label={refreshingPr ? "Refreshing pull request" : "Refresh pull request"}')
    expect(source).toContain('disabled={refreshingPr}')
  })

  test('refreshes the provider data and revision-backed review state', () => {
    // WHY: A spinning button that reloads only the active tab can leave the
    // threads, interdiff, or change itself stale after the provider head moves.
    expect(source).toContain('await activityFeedRef.refresh()')
    expect(source).toContain('loadThreads(true)')
    expect(source).toContain('loadInterdiff(true)')
    expect(source).toContain('review.loadDiff(true)')
    expect(source).toContain('onRefreshTarget?.()')
  })
})
