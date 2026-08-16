import type { GitAction, GitState } from '../../../../shared/types'

export type GitPrimaryAction =
  | { kind: 'run'; label: string; action: GitAction; createFeatureBranch?: boolean }
  | { kind: 'view'; label: string; url: string }
  | { kind: 'disabled'; label: string; reason: string }

/** One publish step the "Commit and push" row bundles, offered on its own from
 *  that row's caret menu. A step that cannot apply stays visible and disabled
 *  with its reason, so the menu reports the branch's state rather than hiding it. */
export interface GitPublishStep {
  key: 'push' | 'create_pull_request'
  label: string
  action: GitAction
  disabled: boolean
  reason?: string
}

export function publishStepStates(status: GitState | null | undefined): GitPublishStep[] {
  const unavailable = !status
    ? 'Git status is unavailable.'
    : !status.branch
      ? 'Detached HEAD cannot publish.'
      : null
  const isDefaultBranch = !!status && status.branch === status.targetBranch
  const targetAhead = status?.targetAheadCount ?? 0
  // Without an upstream nothing has ever been published, so commits measured
  // against the target branch are what a push would carry.
  const hasUnpushedCommits = !!status && (status.upstreamRef ? status.aheadCount > 0 : targetAhead > 0)

  const pushReason =
    unavailable ??
    (status && status.behindCount > 0
      ? 'The branch is behind its upstream — sync first.'
      : hasUnpushedCommits
        ? undefined
        : 'There is nothing to push.')
  const pullRequestReason =
    unavailable ??
    (status?.prUrl
      ? 'This branch already has a pull request.'
      : isDefaultBranch
        ? 'Open a pull request from a feature branch.'
        : targetAhead > 0
          ? undefined
          : 'This branch has no commits to open.')

  return [
    { key: 'push', label: 'Push', action: 'push', disabled: !!pushReason, reason: pushReason },
    {
      key: 'create_pull_request',
      label: 'Create PR',
      action: 'create_pull_request',
      disabled: !!pullRequestReason,
      reason: pullRequestReason,
    },
  ]
}

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
