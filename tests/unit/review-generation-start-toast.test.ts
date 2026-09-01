import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const workspaceUi = join(import.meta.dir, '../../packages/workspace-ui/src/components')

function source(relativePath: string): string {
  return readFileSync(join(workspaceUi, relativePath), 'utf8')
}

function countStartedToasts(relativePath: string): number {
  return source(relativePath).match(/toasts\.info\([^)]*Started generating/gs)?.length ?? 0
}

describe('review generation start feedback', () => {
  test('covers each guide and report generation entry point', () => {
    // WHY: generation continues in the background. Every shared client surface
    // must confirm the click at once instead of leaving the user to infer it
    // from a later status change.
    expect(countStartedToasts('review/ReviewGuideCard.svelte')).toBe(1)
    expect(countStartedToasts('review/ReviewSurface.svelte')).toBe(2)
    expect(countStartedToasts('pr-review/PrReviewPane.svelte')).toBe(2)
    expect(countStartedToasts('prs/PrsPage.svelte')).toBe(1)
    expect(countStartedToasts('project-panel/GitSection.svelte')).toBe(1)
  })
})
