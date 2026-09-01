import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('review-guide feedback session routing', () => {
  test('routes working-tree and prepared PR feedback to a fresh session', () => {
    // WHY: Neither target belongs to the conversation that requested the
    // guide. Feedback must run in a new session against the reviewed checkout.
    const reviewSurface = source(
      'packages/workspace-ui/src/components/review/ReviewSurface.svelte',
    )
    const diffPanel = source(
      'packages/workspace-ui/src/components/diff/DiffPanel.svelte',
    )

    expect(reviewSurface).toContain('feedbackToNewSession={target?.kind === "pr"}')
    expect(reviewSurface).toContain('workingDirectory: checkoutRepoRoot')
    expect(reviewSurface).toContain('serverId: getServerId()')
    expect(diffPanel).toContain('isWorkingTreeScope || feedbackToNewSession')
    expect(diffPanel).toContain('sessionTarget: feedbackSessionTarget')
  })
})
