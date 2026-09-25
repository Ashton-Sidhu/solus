import { isSolusWorktreePath, type GitCheckout, type Message } from '@solus/contracts/types'
import { worktreeDisplayName } from '../../../lib/git-context'

/** Resolve renames from the same checkout the environment panel displays.
 * Older dividers have only the original branch; managed checkout paths retain
 * that branch's slug even after Git renames it. */
export function worktreeDividerName(
  message: Pick<Message, 'worktreeMovedTo' | 'worktreeMovedToPath'>,
  checkout: GitCheckout | null,
): string {
  const originalName = message.worktreeMovedTo ?? ''
  const worktreePath = checkout?.worktreePath
  if (!worktreePath) return originalName
  const matches = message.worktreeMovedToPath
    ? message.worktreeMovedToPath === worktreePath
    : !!originalName && isSolusWorktreePath(worktreePath)
      && worktreePath.endsWith(`/${originalName.replace(/\//g, '-')}`)
  if (!matches) return originalName
  return checkout.branch ? worktreeDisplayName(checkout.branch) : checkout.detachedHeadSha ?? 'detached HEAD'
}
