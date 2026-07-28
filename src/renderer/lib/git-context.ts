import { worktreeProjectRoot, type GitCheckout } from '../../shared/types'

/**
 * The three facts a pre-session surface needs about a working directory: the
 * repo it belongs to, the branch a worktree would be cut from, and whether
 * isolation is still a choice (you can't branch out of a worktree you're in).
 */
export function homeGitDetails(
  currentDir: string,
  gitContext: GitCheckout | null | undefined,
  defaultGitContext: GitCheckout | null,
) {
  const currentGitContext = gitContext ?? defaultGitContext
  return {
    projectRoot: currentDir && currentDir !== '~' ? worktreeProjectRoot(currentDir) : null,
    baseBranch: currentGitContext?.targetBranch ?? 'main',
    canToggleWorktree: !!currentGitContext?.targetBranch && !currentGitContext.worktreePath,
  }
}

function capitalizeFirst(value: string): string {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function removeSolusWorktreeSuffix(value: string): string {
  return value
    .replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, '')
    .replace(/-[a-z0-9]{5}$/i, '')
}

function formatFriendlyBranchName(branch: string): string {
  const words = branch
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()

  return capitalizeFirst(words || branch)
}

export function formatBranchDisplayName(branch: string, targetBranch: string, isWorktree: boolean): string {
  if (!isWorktree && branch === targetBranch) {
    return capitalizeFirst(branch)
  }

  if (isWorktree) {
    const worktreeBranch = branch.startsWith('solus/')
      ? removeSolusWorktreeSuffix(branch.slice('solus/'.length))
      : branch
    return formatFriendlyBranchName(worktreeBranch)
  }

  return formatFriendlyBranchName(branch)
}
