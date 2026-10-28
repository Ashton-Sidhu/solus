import { worktreeProjectRoot, type BranchRef, type GitCheckout } from '@solus/contracts/types'

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

/**
 * The branches a picker lists below the ones it shows on their own: the
 * default branch first, as the usual place to start, then the rest most
 * recently active first, as the host orders them.
 */
export function pickerBranches(branches: readonly BranchRef[], shownApart: ReadonlySet<string>): BranchRef[] {
  const listed = branches.filter((branch) => !shownApart.has(branch.name))
  const defaultIndex = listed.findIndex((branch) => branch.isDefault)
  if (defaultIndex > 0) listed.unshift(...listed.splice(defaultIndex, 1))
  return listed
}

/** A large repository has tens of thousands of branches. The picker mounts
 *  at most this many rows; a search reaches the rest. */
export const BRANCH_ROWS_SHOWN = 100

/** The first `limit` branches whose names hold every word of the search, in
 *  list order. It stops at `limit`, so a short search over a huge list is cheap. */
export function branchesMatching(branches: readonly BranchRef[], search: string, limit: number): BranchRef[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const matches: BranchRef[] = []
  for (const branch of branches) {
    if (matches.length === limit) break
    const name = branch.name.toLowerCase()
    if (words.every((word) => name.includes(word))) matches.push(branch)
  }
  return matches
}

/** The branch a search would create, or null when the search is empty or
 *  already names a branch. */
export function newBranchFromSearch(search: string, existing: readonly string[]): string | null {
  const name = search.trim()
  if (!name || /\s/.test(name) || existing.includes(name)) return null
  return name
}
