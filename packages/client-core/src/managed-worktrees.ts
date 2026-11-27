import {
  managedWorktreeState,
  type ManagedWorktree,
  type ManagedWorktreeRemoveResult,
} from '@solus/contracts/git-types'
import type { HostApi } from './host-api'
import { formatResourceBytes } from './host-resource-watch'

export function worktreeStatusText(worktree: ManagedWorktree): string {
  switch (managedWorktreeState(worktree)) {
    case 'in_use': return 'A turn is running'
    case 'unsaved': return worktree.hasUncommittedWork ? 'Has uncommitted work' : 'Has unmerged commits'
    case 'safe': return 'No unsaved work'
  }
}

export function idleSessions(worktree: ManagedWorktree): ManagedWorktree['sessions'] {
  return worktree.sessions.filter((session) => !session.isBusy)
}

export function deleteConfirmText(worktree: ManagedWorktree, bytes?: number | null): string {
  const lost = [
    worktree.hasUncommittedWork ? 'its uncommitted work' : null,
    worktree.hasUnmergedCommits ? 'the commits that are only on its branch' : null,
  ].filter(Boolean)
  const sentences = [
    lost.length ? `You lose ${lost.join(' and ')}.` : 'No work is lost.',
    ...idleSessions(worktree).map((session) => `“${session.title}” is open. It loses its working folder; its conversation stays.`),
    worktree.branch
      ? `The branch ${worktree.branch} is deleted${worktree.kind === 'task_folder' ? ' in each repository' : ''}.`
      : null,
    bytes !== undefined && bytes !== null ? `Frees ${formatResourceBytes(bytes)}.` : null,
  ]
  return sentences.filter(Boolean).join(' ')
}

export function keptBranchNotice(worktree: ManagedWorktree, error: string): string {
  return `Deleted ${worktree.title}. The branch ${worktree.branch ?? ''} stays: ${error}`
}

export function worktreeRemovalError(result: Exclude<ManagedWorktreeRemoveResult, { status: 'removed' }>): string {
  switch (result.status) {
    case 'unsaved': return 'It has new unsaved work. Confirm again to delete it.'
    case 'in_use': return 'A session works here now.'
    case 'failed': return result.error
  }
}

/** Run in order so two removals from the same repository cannot contend for Git locks. */
export async function* removeConfirmedWorktrees(
  api: Pick<HostApi, 'managedWorktreeRemove'>,
  worktrees: readonly ManagedWorktree[],
) {
  for (const worktree of worktrees) {
    let result: ManagedWorktreeRemoveResult
    try {
      // Only force the worktrees whose unsaved work the user confirmed.
      result = await api.managedWorktreeRemove(worktree.path, {
        force: managedWorktreeState(worktree) === 'unsaved',
      })
    } catch (error) {
      result = { status: 'failed', error: error instanceof Error ? error.message : 'Could not delete the worktree.' }
    }
    yield { worktree, result }
  }
}
