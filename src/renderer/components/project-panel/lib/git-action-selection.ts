import type { GitAction, GitState } from '../../../../shared/types'

export type GitPrimaryAction =
  | { kind: 'run'; label: string; action: GitAction; createFeatureBranch?: boolean }
  | { kind: 'view'; label: string; url: string }
  | { kind: 'disabled'; label: string; reason: string }

export function primaryGitAction(status: GitState | null | undefined): GitPrimaryAction {
  if (!status) return { kind: 'disabled', label: 'Pull requests', reason: 'Git status is unavailable.' }
  if (!status.branch) return { kind: 'disabled', label: 'Pull requests', reason: 'Detached HEAD cannot open a pull request.' }
  const isDefaultBranch = status.branch === status.targetBranch
  const hasChanges = status.uncommittedChanges.files.length > 0 || status.uncommittedChanges.hasMoreFiles
  if (status.behindCount > 0) {
    return { kind: 'disabled', label: 'Sync before publishing', reason: 'The branch is behind its upstream.' }
  }
  if (hasChanges) {
    if (isDefaultBranch) {
      return {
        kind: 'run',
        label: 'Create feature branch and open PR',
        action: 'commit_push_pull_request',
        createFeatureBranch: true,
      }
    }
    if (status.prUrl) return { kind: 'run', label: 'Commit and push', action: 'commit_push' }
    return { kind: 'run', label: 'Commit, push and open PR', action: 'commit_push_pull_request' }
  }
  if (status.prUrl) {
    if (status.aheadCount > 0) return { kind: 'run', label: 'Push pull request updates', action: 'push' }
    return { kind: 'view', label: 'View pull request', url: status.prUrl }
  }
  if (isDefaultBranch) {
    return { kind: 'disabled', label: 'Pull requests', reason: 'Create changes on a feature branch first.' }
  }
  if ((status.targetAheadCount ?? 0) > 0) {
    return {
      kind: 'run',
      label: status.upstreamRef && status.aheadCount === 0 ? 'Open pull request' : 'Push and open PR',
      action: 'create_pull_request',
    }
  }
  return { kind: 'disabled', label: 'Pull requests', reason: 'This branch has no changes to open.' }
}
