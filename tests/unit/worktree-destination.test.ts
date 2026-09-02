import { expect, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { withSelectedWorktree } from '@solus/workspace-ui/components/input/lib/worktree-destination'

test('an input composer can replace one selected worktree with another', () => {
  const firstSelection: RunConfig = {
    workingDirectory: '/projects/solus',
    gitContext: {
      repoRoot: '/projects/solus',
      worktreePath: '/tmp/first-worktree',
      branch: 'first',
      targetBranch: 'main',
    },
    worktree: { baseBranch: 'main' },
  } as RunConfig

  const next = withSelectedWorktree(
    firstSelection,
    '/projects/solus',
    { path: '/tmp/second-worktree', branch: 'second' },
    'main',
  )

  // WHY: the Git picker is a pre-flight choice. A second choice must replace
  // only the checkout while the project chip stays at the canonical root.
  expect(next.workingDirectory).toBe('/projects/solus')
  expect(next.gitContext).toEqual({
    repoRoot: '/projects/solus',
    worktreePath: '/tmp/second-worktree',
    branch: 'second',
    targetBranch: 'main',
  })
  expect(next.worktree).toBeNull()
})
