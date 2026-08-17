import type { GitAction, GitRepositoryStatus, GitState } from '../../../../shared/types'

/**
 * How far the project has come towards publishable work. The Git rows keep
 * their positions at every stage; only their primary action and menu contents
 * change, so a user always looks in the same place.
 */
export type GitReadiness = 'no-repository' | 'local-only' | 'published'

export type GitPrimaryAction =
  | { kind: 'run'; label: string; action: GitAction; createFeatureBranch?: boolean }
  /** Opens an existing pull request on the git host. */
  | { kind: 'view'; label: string; url: string }
  /** Opens the publish dialog — the project has no remote yet. */
  | { kind: 'publish'; label: string }
  /** The publish path needs a GitHub connection first. */
  | { kind: 'connect'; label: string }
  | { kind: 'disabled'; label: string; reason: string }

/**
 * One item in a row's caret menu: the by-hand version of a step the row's
 * primary action bundles. A step that cannot apply stays visible and disabled
 * with its reason, so the menu reports the project's state rather than hiding it.
 */
export interface GitMenuStep {
  key: 'commit_with_options' | 'commit_only' | 'push' | 'create_pull_request'
  label: string
  action: GitAction
  disabled: boolean
  reason?: string
}

export interface GitPublishModel {
  readiness: GitReadiness
  /** Local work and how far it travels: staging, message, push. */
  commit: { primary: GitPrimaryAction; steps: GitMenuStep[] }
  /** The remote and the pull request — including creating the remote. */
  pullRequest: { primary: GitPrimaryAction; steps: GitMenuStep[] }
  sync: { disabled: boolean; reason?: string }
}

export interface GitRepositorySetup {
  /** The repository probe, or null/undefined while it has not answered yet. */
  repository: GitRepositoryStatus | null | undefined
  /** Whether the host has a usable GitHub connection, or null while unknown. */
  githubConnected: boolean | null
}

const NO_REMOTE_REASON = 'This project has no remote. Publish it from Pull requests.'

export function gitReadiness(repository: GitRepositoryStatus | null | undefined): GitReadiness {
  // An unanswered probe keeps the published ladder, so the rows do not flash
  // through a publish state the project may not be in.
  if (!repository) return 'published'
  if (!repository.isRepository) return 'no-repository'
  return repository.primaryRemoteUrl ? 'published' : 'local-only'
}

function hasUncommittedChanges(status: GitState): boolean {
  return status.uncommittedChanges.files.length > 0 || status.uncommittedChanges.hasMoreFiles
}

/**
 * The single reading of the project's Git state that both rows and both menus
 * render from. One function owns every enabled/disabled decision, so a row
 * label and its menu can never report different states.
 */
export function gitPublishModel(
  status: GitState | null | undefined,
  setup: GitRepositorySetup = { repository: undefined, githubConnected: null },
): GitPublishModel {
  const readiness = gitReadiness(setup.repository)
  const unavailable = !status
    ? 'Git status is unavailable.'
    : !status.branch
      ? 'Detached HEAD cannot publish.'
      : readiness === 'no-repository'
        ? 'This folder is not a Git repository.'
        : null

  if (unavailable || !status) {
    const reason = unavailable ?? 'Git status is unavailable.'
    return {
      readiness,
      commit: {
        primary: { kind: 'disabled', label: 'Commit', reason },
        steps: [
          commitWithOptionsStep('commit', true, reason),
          pushStep(true, reason),
        ],
      },
      pullRequest: {
        primary: { kind: 'disabled', label: 'Pull requests', reason },
        steps: [createPullRequestStep(true, reason)],
      },
      sync: { disabled: true, reason },
    }
  }

  const changesReason = hasUncommittedChanges(status) ? undefined : 'There are no uncommitted changes.'

  if (readiness === 'local-only') {
    return {
      readiness,
      commit: {
        // Nothing can travel yet, so the row commits and stops there.
        primary: { kind: 'run', label: 'Commit', action: 'commit' },
        steps: [
          commitWithOptionsStep('commit', !!changesReason, changesReason),
          pushStep(true, NO_REMOTE_REASON),
        ],
      },
      pullRequest: {
        // Publishing creates the remote, so the pull-request row owns it.
        primary:
          setup.githubConnected === false
            ? { kind: 'connect', label: 'Connect GitHub…' }
            : { kind: 'publish', label: 'Publish to GitHub…' },
        steps: [createPullRequestStep(true, NO_REMOTE_REASON)],
      },
      sync: { disabled: true, reason: 'This project has no remote.' },
    }
  }

  return {
    readiness,
    commit: {
      primary: { kind: 'run', label: 'Commit and push', action: 'commit_push' },
      steps: [
        commitWithOptionsStep('commit_push', !!changesReason, changesReason),
        {
          key: 'commit_only',
          label: 'Commit only',
          action: 'commit',
          disabled: !!changesReason,
          reason: changesReason,
        },
        pushStepFor(status),
      ],
    },
    pullRequest: {
      primary: pullRequestPrimary(status),
      steps: [createPullRequestStepFor(status)],
    },
    sync: { disabled: false },
  }
}

function commitWithOptionsStep(
  action: Extract<GitAction, 'commit' | 'commit_push'>,
  disabled: boolean,
  reason?: string,
): GitMenuStep {
  return { key: 'commit_with_options', label: 'Commit…', action, disabled, reason }
}

function pushStep(disabled: boolean, reason?: string): GitMenuStep {
  return { key: 'push', label: 'Push', action: 'push', disabled, reason }
}

function pushStepFor(status: GitState): GitMenuStep {
  // Without an upstream nothing has ever been published, so commits measured
  // against the target branch are what a push would carry.
  const hasUnpushedCommits = status.upstreamRef ? status.aheadCount > 0 : (status.targetAheadCount ?? 0) > 0
  const reason =
    status.behindCount > 0
      ? 'The branch is behind its upstream — sync first.'
      : hasUnpushedCommits
        ? undefined
        : 'There is nothing to push.'
  return pushStep(!!reason, reason)
}

function createPullRequestStep(disabled: boolean, reason?: string): GitMenuStep {
  return { key: 'create_pull_request', label: 'Create PR', action: 'create_pull_request', disabled, reason }
}

function createPullRequestStepFor(status: GitState): GitMenuStep {
  const reason = status.prUrl
    ? 'This branch already has a pull request.'
    : status.branch === status.targetBranch
      ? 'Open a pull request from a feature branch.'
      : (status.targetAheadCount ?? 0) > 0
        ? undefined
        : 'This branch has no commits to open.'
  return createPullRequestStep(!!reason, reason)
}

function pullRequestPrimary(status: GitState): GitPrimaryAction {
  const isDefaultBranch = status.branch === status.targetBranch
  if (status.behindCount > 0) {
    return { kind: 'disabled', label: 'Sync before publishing', reason: 'The branch is behind its upstream.' }
  }
  if (hasUncommittedChanges(status)) {
    if (isDefaultBranch) {
      return {
        kind: 'run',
        label: 'Branch and open PR',
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
