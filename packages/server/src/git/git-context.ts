import type { GitCheckout, GitIdentity } from '@solus/contracts/types'

/** Apply live Git identity without replacing a worktree's owning project root. */
export function checkoutWithLiveIdentity(
  checkout: GitCheckout,
  identity: GitIdentity,
): GitCheckout {
  return {
    ...checkout,
    branch: identity.branch,
    ...(identity.branch === null
      ? { detachedHeadSha: identity.headSha }
      : { detachedHeadSha: undefined }),
    targetBranch: identity.targetBranch,
    // rev-parse reports the linked checkout as its top level. A worktree
    // context already carries the main project root, which must stay stable so
    // a new session can inherit the complete context.
    repoRoot: checkout.worktreePath ? checkout.repoRoot : identity.repoRoot,
  }
}
