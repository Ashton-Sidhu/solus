import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('pull request label management', () => {
  test('keeps labels in the shared facts list and reuses list label colours', () => {
    // WHY: labels must remain visible at every rail rung, and a successful
    // edit must use the same host-colour treatment as the PR list row.
    const feed = read('packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte')
    const facts = read('packages/workspace-ui/src/components/pr-review/PrLabelFacts.svelte')

    expect(feed).toContain('<PrLabelFacts')
    expect(feed).toContain('onSet={canManageLabels ? setLabels : undefined}')
    expect(facts).toContain('labelChipColor(label.color)')
    expect(facts).toContain('<DropdownMenu.CheckboxItem')
    expect(facts).toContain('placeholder="Search labels…"')
  })

  test('routes reads and writes through the pull request store', () => {
    const pullRequest = read('packages/workspace-ui/src/contexts/prs/pull-request.svelte.ts')
    expect(pullRequest).toContain('this.api.prListLabelCandidates(ctx, this.number)')
    expect(pullRequest).toContain('this.api.prSetLabels(detached(this.ctx), this.number, [...names])')
    expect(pullRequest).toContain('this.store.applyLabels(this.number, labels)')
  })
})
