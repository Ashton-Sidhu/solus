import { worktreeProjectRoot, type GitCheckout } from '@solus/contracts/types'

/**
 * The three facts a pre-session surface needs about a working directory: the
 * repo it belongs to, the branch a worktree would be cut from, and whether
 * isolation is available. A session already in a worktree can still start a
 * sibling worktree from the repository's default branch.
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
    canToggleWorktree: !!currentGitContext?.targetBranch,
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

/**
 * Solus-managed worktrees share the `solus/` branch namespace. It identifies
 * ownership, not the worktree, so omit it anywhere the UI names that worktree.
 */
export function worktreeDisplayName(branch: string): string {
  const name = branch.startsWith('solus/') ? branch.slice('solus/'.length) : branch
  return name || branch
}

export function formatBranchDisplayName(branch: string, targetBranch: string, isWorktree: boolean): string {
  if (!isWorktree && branch === targetBranch) {
    return capitalizeFirst(branch)
  }

  if (isWorktree) {
    const worktreeBranch = removeSolusWorktreeSuffix(worktreeDisplayName(branch))
    return formatFriendlyBranchName(worktreeBranch)
  }

  return formatFriendlyBranchName(branch)
}
