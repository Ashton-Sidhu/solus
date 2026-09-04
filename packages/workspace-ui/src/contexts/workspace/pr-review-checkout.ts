import { worktreeProjectRoot, type GitCheckout, type PrReviewContext } from '@solus/contracts/types'

/** The complete Git context shared by every session opened on a PR checkout. */
export function prReviewGitCheckout(
  review: Pick<PrReviewContext, 'branch' | 'baseRef' | 'worktreePath'>,
): GitCheckout {
  return {
    repoRoot: worktreeProjectRoot(review.worktreePath),
    branch: review.branch,
    targetBranch: review.baseRef,
    worktreePath: review.worktreePath,
  }
}
