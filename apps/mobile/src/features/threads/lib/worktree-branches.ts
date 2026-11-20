import type { BranchRef } from '@solus/contracts/git-types'

/** Prefer the project's current checkout, as T3 does. A detached or unavailable
 * checkout falls back to the remote default, then a recently used local branch. */
export function defaultWorktreeBase(branches: readonly BranchRef[], currentBranch?: string | null): string | null {
  const local = branches.filter((branch) => !branch.remoteOnly)
  return (local.find((branch) => branch.name === currentBranch) ?? branches.find((branch) => branch.isDefault) ?? newestFirst(local)[0] ?? newestFirst(branches)[0])?.name ?? null
}

/** The base branch picker's rows: the default branch first, then the branches
 *  used most recently, that contain the query. */
export function worktreeBaseChoices(branches: readonly BranchRef[], query: string): BranchRef[] {
  const needle = query.trim().toLocaleLowerCase()
  const matching = needle ? branches.filter((branch) => branch.name.toLocaleLowerCase().includes(needle)) : branches
  return newestFirst(matching).sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/** The picker's selected row, as T3: the picked branch, else the checkout's, else the default. */
export function selectedBranchName(branches: readonly BranchRef[] | null, picked: string | null): string | null {
  return picked ?? branches?.find((branch) => branch.current)?.name ?? branches?.find((branch) => branch.isDefault)?.name ?? null
}

/** T3's branch badge (`branchBadgeLabel`), the first that applies. An older
 *  host does not mark the current branch; `currentBranch` names it then. */
export function branchBadge(branch: BranchRef, currentBranch: string | null): 'CURRENT' | 'WORKTREE' | 'REMOTE' | 'DEFAULT' | null {
  if (branch.current ?? branch.name === currentBranch) return 'CURRENT'
  if (branch.worktreePath) return 'WORKTREE'
  if (branch.remoteOnly) return 'REMOTE'
  if (branch.isDefault) return 'DEFAULT'
  return null
}

function newestFirst(branches: readonly BranchRef[]): BranchRef[] {
  return [...branches].sort((a, b) => b.activeAt - a.activeAt)
}
