import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const workspaceSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)
const reviewPaneSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/review/ReviewPane.svelte'),
  'utf8',
)

describe('review default view', () => {
  test('opens direct review actions and omitted route views on the diff', () => {
    // WHY: Diff is the primary review surface. Map and Guide are optional
    // alternate views, so an entry action must not select them implicitly.
    expect(workspaceSource).toMatch(
      /showDiff\([\s\S]*const params: RouteParams\['review'\] = \{[\s\S]*view: 'diff'/,
    )
    expect(reviewPaneSource).toContain(
      'const view = $derived<ReviewView>(params.view ?? "diff");',
    )
  })
})
