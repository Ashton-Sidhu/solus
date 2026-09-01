import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const reviewGuideCard = readFileSync(
  join(root, 'packages/workspace-ui/src/components/review/ReviewGuideCard.svelte'),
  'utf8',
)
const workspaceContext = readFileSync(
  join(root, 'packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)
const reviewSurface = readFileSync(
  join(root, 'packages/workspace-ui/src/components/review/ReviewSurface.svelte'),
  'utf8',
)
const reviewPanelMenu = readFileSync(
  join(root, 'packages/workspace-ui/src/components/diff/ReviewPanelOverflowMenu.svelte'),
  'utf8',
)
const prPanelMenu = readFileSync(
  join(root, 'packages/workspace-ui/src/components/pr-review/PrPanelOverflowMenu.svelte'),
  'utf8',
)
const guideLoader = readFileSync(
  join(root, 'packages/workspace-ui/src/components/review/lib/guide-loader.svelte.ts'),
  'utf8',
)

describe('external review-guide navigation', () => {
  test('offers full and new-commit regeneration when a guide is stale', () => {
    // WHY: Re-reading a large guide after one small follow-up commit wastes the
    // reviewer's attention, but replacing the full review must remain explicit.
    for (const menu of [reviewPanelMenu, prPanelMenu]) {
      expect(menu).toContain('Review new commits only')
      expect(menu).toContain('Regenerate full guide')
      expect(menu).toContain('guide.onRegenerate("new-commits")')
      expect(menu).toContain('guide.onRegenerate("full")')
    }
    expect(guideLoader).toContain("? this.guide?.headSha")
    expect(guideLoader).toContain('regenerationBaseSha')
  })

  test('opens the prepared checkout guide instead of the pull request URL', () => {
    // WHY: An arbitrary PR can belong to a different repository than the
    // requesting session. Its ready status is the authority for the checkout
    // and guide key; opening it as a project PR falls back to GitHub.
    expect(reviewGuideCard).toContain('repoRoot: status.repoRoot')
    expect(reviewGuideCard).toContain('key: status.key')
    expect(reviewGuideCard).toContain('status.target ?? ref.target')
    expect(workspaceContext).toContain("name: 'review'")
    expect(workspaceContext).toContain('guideKey: prepared.key')
    expect(workspaceContext).toContain('cwd: prepared.repoRoot')
    expect(reviewSurface).toContain('session.ctxForEnvironment(')
    expect(reviewSurface).toContain('repoRoot: checkoutRepoRoot')
    expect(reviewSurface).toContain('worktreePath: checkoutRepoRoot')
    expect(reviewSurface).toContain('reviewLabel={targetLabel}')
    expect(reviewSurface).toContain('targetPullRequest ? loader.diffScope : branchScope')
  })
})
