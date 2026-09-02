import type { RunConfig, WorktreeEntry } from '@solus/contracts/types'
import { withCheckout } from '../../../contexts/workspace/run-config'

/** Select an existing worktree for a composer without changing its project or
 * retaining a request to create another worktree when the prompt is sent. */
export function withSelectedWorktree(
  run: RunConfig,
  projectRoot: string,
  worktree: WorktreeEntry,
  fallbackTargetBranch: string | null,
): RunConfig {
  return {
    ...withCheckout(run, projectRoot, {
      repoRoot: projectRoot,
      worktreePath: worktree.path,
      branch: worktree.branch,
      targetBranch: run.gitContext?.targetBranch ?? fallbackTargetBranch ?? worktree.branch,
    }),
    worktree: null,
  }
}
