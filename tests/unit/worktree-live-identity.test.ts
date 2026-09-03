import { describe, expect, test } from 'bun:test'
import type { GitCheckout, GitIdentity } from '@solus/contracts/types'
import { checkoutWithLiveIdentity } from '@solus/server/git/git-context'

const liveIdentity: GitIdentity = {
  repoRoot: '/projects/solus/.git/solus/worktrees/fix',
  headSha: 'abc123',
  branch: 'solus/fix',
  targetBranch: 'main',
}

describe('live Git identity', () => {
  test('keeps the owning project root in a worktree context', () => {
    // WHY: Cmd+T inherits this complete Git context. Replacing repoRoot with
    // the linked checkout path makes the next session mistake it for a project.
    const checkout: GitCheckout = {
      repoRoot: '/projects/solus',
      branch: 'solus/fix',
      targetBranch: 'main',
      worktreePath: '/projects/solus/.git/solus/worktrees/fix',
    }

    expect(checkoutWithLiveIdentity(checkout, liveIdentity)).toEqual(checkout)
  })

  test('updates the repository root for a normal checkout', () => {
    const checkout: GitCheckout = {
      repoRoot: '/projects/old',
      branch: 'old',
      targetBranch: 'old-main',
    }

    expect(checkoutWithLiveIdentity(checkout, liveIdentity)).toEqual({
      repoRoot: liveIdentity.repoRoot,
      branch: liveIdentity.branch,
      targetBranch: liveIdentity.targetBranch,
      detachedHeadSha: undefined,
    })
  })
})
