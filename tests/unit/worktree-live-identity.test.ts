import { describe, expect, test } from 'bun:test'
import type { GitCheckout, GitIdentity } from '@solus/contracts/types'
import { checkoutWithLiveIdentity } from '@solus/server/git/git-context'
import { prReviewGitCheckout } from '@solus/workspace-ui/contexts/workspace/pr-review-checkout'
import { inheritRunConfig } from '@solus/workspace-ui/contexts/workspace/run-config'

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

describe('PR review Git context', () => {
  test('Ask Solus keeps both the project root and the worktree path', () => {
    expect(prReviewGitCheckout({
      branch: 'pr-42',
      baseRef: 'main',
      worktreePath: '/projects/solus/.git/solus/worktrees/pr-42',
    })).toEqual({
      repoRoot: '/projects/solus',
      branch: 'pr-42',
      targetBranch: 'main',
      worktreePath: '/projects/solus/.git/solus/worktrees/pr-42',
    })
  })
})

describe('draft Git context', () => {
  test('every draft constructor inherits a complete worktree context', () => {
    const defaults = {
      workingDirectory: '/repo',
      gitContext: null,
      worktree: null,
      modelConfig: { modelId: null, reasoningEffort: 'high' as const, contextWindow: null, fastMode: false },
      permissionMode: 'ask' as const,
      provider: 'codex' as const,
      serverId: 'local',
      taskServerId: 'local',
      projectGroupPath: null,
      sessionSkills: [],
      pendingHostDispatch: null,
    }
    const source = {
      ...defaults,
      gitContext: {
        repoRoot: '/repo',
        branch: 'feature',
        targetBranch: 'main',
        worktreePath: '/repo/.git/solus/worktrees/feature',
      },
    }

    expect(inheritRunConfig(defaults, source).gitContext).toEqual(source.gitContext)
  })
})
