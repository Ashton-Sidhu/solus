import { isSolusWorktreePath, type GitCheckout } from '@solus/contracts/types'
import { worktreeDisplayName } from '../../../lib/git-context'

/** Where a session moved: the checkout path, and the branch it had then. */
export interface WorktreeMove {
  path?: string
  branch?: string
}

/** Resolve renames from the same checkout the environment panel displays.
 * A move without a path has only the original branch; managed checkout paths
 * retain that branch's slug even after Git renames it. */
export function worktreeDividerName(
  move: WorktreeMove,
  checkout: GitCheckout | null,
): string {
  const originalName = move.branch ?? ''
  const worktreePath = checkout?.worktreePath
  if (!worktreePath) return originalName
  const matches = move.path
    ? move.path === worktreePath
    : !!originalName && isSolusWorktreePath(worktreePath)
      && worktreePath.endsWith(`/${originalName.replace(/\//g, '-')}`)
  if (!matches) return originalName
  return checkout.branch ? worktreeDisplayName(checkout.branch) : checkout.detachedHeadSha ?? 'detached HEAD'
}
