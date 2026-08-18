import { describe, expect, test } from 'bun:test'
import {
  gitPublishModel,
  gitReadiness,
  isPullRequestRunning,
  type GitRepositorySetup,
} from '../../src/renderer/components/project-panel/lib/git-action-selection'
import type { GitRepositoryStatus, GitState } from '../../src/shared/types'

function status(overrides: Partial<GitState> = {}): GitState {
  return {
    repoRoot: '/repo',
    headSha: 'abc123',
    branch: 'feature/change',
    targetBranch: 'main',
    upstreamRef: 'origin/feature/change',
    aheadCount: 0,
    behindCount: 0,
    targetAheadCount: 1,
    uncommittedChanges: {
      files: [],
      hasMoreFiles: false,
      insertions: 0,
      deletions: 0,
      mergeInProgress: false,
    },
    ...overrides,
  }
}

function dirty(): GitState['uncommittedChanges'] {
  return {
    files: [{ path: 'src/git.ts', conflicted: false }],
    hasMoreFiles: false,
    insertions: 4,
    deletions: 0,
    mergeInProgress: false,
  }
}

function repository(overrides: Partial<GitRepositoryStatus> = {}): GitRepositoryStatus {
  return {
    isRepository: true,
    hasCommits: true,
    branch: 'feature/change',
    primaryRemoteName: 'origin',
    primaryRemoteUrl: 'git@github.com:solus-sh/solus.git',
    ...overrides,
  }
}

const PUBLISHED: GitRepositorySetup = { repository: repository(), githubConnected: true }
const LOCAL_ONLY: GitRepositorySetup = {
  repository: repository({ primaryRemoteName: null, primaryRemoteUrl: null }),
  githubConnected: true,
}

function step(model: ReturnType<typeof gitPublishModel>, key: string) {
  const found = [...model.commit.steps, ...model.pullRequest.steps].find((candidate) => candidate.key === key)
  if (!found) throw new Error(`no step ${key}`)
  return found
}

describe('gitReadiness', () => {
  test('separates the three stages of a project', () => {
    expect(gitReadiness(repository({ isRepository: false }))).toBe('no-repository')
    expect(gitReadiness(repository({ primaryRemoteUrl: null }))).toBe('local-only')
    expect(gitReadiness(repository())).toBe('published')
  })

  test('an unanswered probe keeps the published ladder rather than flashing a publish state', () => {
    expect(gitReadiness(undefined)).toBe('published')
  })
})

describe('gitPublishModel — published', () => {
  test('moves dirty default-branch work to a feature branch before opening a PR', () => {
    const model = gitPublishModel(
      status({ branch: 'main', targetBranch: 'main', uncommittedChanges: dirty() }),
      PUBLISHED,
    )
    expect(model.pullRequest.primary).toEqual({
      kind: 'run',
      label: 'Branch and open PR',
      action: 'commit_push_pull_request',
      createFeatureBranch: true,
    })
  })

  test('opens a PR from a clean feature branch with unpublished commits', () => {
    expect(gitPublishModel(status({ upstreamRef: null, aheadCount: 0 }), PUBLISHED).pullRequest.primary).toEqual({
      kind: 'run',
      label: 'Push and open PR',
      action: 'create_pull_request',
    })
  })

  test('returns the existing PR when the branch is fully published', () => {
    const model = gitPublishModel(
      status({ prUrl: 'https://github.com/solus-sh/solus/pull/42', targetAheadCount: 2 }),
      PUBLISHED,
    )
    expect(model.pullRequest.primary).toEqual({
      kind: 'view',
      label: 'View pull request',
      url: 'https://github.com/solus-sh/solus/pull/42',
    })
  })

  test('blocks publishing when the branch is behind its upstream', () => {
    expect(gitPublishModel(status({ behindCount: 2 }), PUBLISHED).pullRequest.primary).toMatchObject({
      kind: 'disabled',
      label: 'Sync before publishing',
    })
  })

  // The two menus own separate halves of the work: creating a pull request is
  // offered once, from the row that stands for pull requests.
  test('the commit menu carries local steps and push; the PR menu carries PR creation', () => {
    const model = gitPublishModel(status({ uncommittedChanges: dirty() }), PUBLISHED)
    expect(model.commit.steps.map((entry) => entry.key)).toEqual(['commit_with_options', 'push'])
    expect(model.pullRequest.steps.map((entry) => entry.key)).toEqual(['create_pull_request'])
  })

  // The composer is the only way to commit without pushing, so its step must
  // carry the row's full action for the dialog to offer both halves.
  test('the commit steps commit as far as the row does', () => {
    const model = gitPublishModel(status({ uncommittedChanges: dirty() }), PUBLISHED)
    expect(model.commit.primary).toMatchObject({ label: 'Commit and push', action: 'commit_push' })
    expect(step(model, 'commit_with_options').action).toBe('commit_push')
  })

  test('the commit steps need uncommitted changes', () => {
    const clean = gitPublishModel(status(), PUBLISHED)
    expect(step(clean, 'commit_with_options')).toMatchObject({
      disabled: true,
      reason: 'There are no uncommitted changes.',
    })
    expect(step(gitPublishModel(status({ uncommittedChanges: dirty() }), PUBLISHED), 'commit_with_options').disabled)
      .toBe(false)
  })

  test('push counts against the target branch until the branch has an upstream', () => {
    // Never published: the commits ahead of the target are what a push carries.
    expect(step(gitPublishModel(status({ upstreamRef: null, aheadCount: 0, targetAheadCount: 2 }), PUBLISHED), 'push').disabled).toBe(false)
    expect(step(gitPublishModel(status({ upstreamRef: null, aheadCount: 0, targetAheadCount: 0 }), PUBLISHED), 'push').disabled).toBe(true)
    // Published: only what the upstream is missing counts.
    expect(step(gitPublishModel(status({ aheadCount: 0, targetAheadCount: 3 }), PUBLISHED), 'push').disabled).toBe(true)
    expect(step(gitPublishModel(status({ aheadCount: 1 }), PUBLISHED), 'push').disabled).toBe(false)
  })

  test('push waits for a sync while the branch is behind', () => {
    expect(step(gitPublishModel(status({ aheadCount: 2, behindCount: 1 }), PUBLISHED), 'push')).toMatchObject({
      disabled: true,
      reason: 'The branch is behind its upstream — sync first.',
    })
  })

  test('a branch with a pull request cannot open a second one', () => {
    expect(step(gitPublishModel(status({ prUrl: 'https://github.com/solus-sh/solus/pull/42' }), PUBLISHED), 'create_pull_request')).toMatchObject({
      disabled: true,
      reason: 'This branch already has a pull request.',
    })
    expect(step(gitPublishModel(status(), PUBLISHED), 'create_pull_request').disabled).toBe(false)
  })

  test('the default branch has nothing to open a pull request from', () => {
    expect(step(gitPublishModel(status({ branch: 'main' }), PUBLISHED), 'create_pull_request').disabled).toBe(true)
  })

  test('every step is disabled with a reason on a detached HEAD', () => {
    const model = gitPublishModel(status({ branch: null }), PUBLISHED)
    for (const entry of [...model.commit.steps, ...model.pullRequest.steps]) {
      expect(entry.disabled).toBe(true)
      expect(entry.reason).toBe('Detached HEAD cannot publish.')
    }
    expect(model.sync.disabled).toBe(true)
  })
})

describe('gitPublishModel — local-only', () => {
  // Nothing can travel without a remote, so the rows stop offering to move work
  // and the pull-request row becomes the way to create the remote.
  test('the commit row commits locally and the PR row publishes', () => {
    const model = gitPublishModel(status({ uncommittedChanges: dirty() }), LOCAL_ONLY)
    expect(model.readiness).toBe('local-only')
    expect(model.commit.primary).toEqual({ kind: 'run', label: 'Commit', action: 'commit' })
    expect(step(model, 'commit_with_options').action).toBe('commit')
    expect(model.pullRequest.primary).toEqual({ kind: 'publish', label: 'Publish to GitHub…' })
  })

  test('publishing asks for a GitHub connection first when there is none', () => {
    const model = gitPublishModel(status(), { ...LOCAL_ONLY, githubConnected: false })
    expect(model.pullRequest.primary).toEqual({ kind: 'connect', label: 'Connect GitHub…' })
  })

  test('push, PR creation, and sync all report the missing remote', () => {
    const model = gitPublishModel(status({ aheadCount: 3, uncommittedChanges: dirty() }), LOCAL_ONLY)
    expect(step(model, 'push')).toMatchObject({ disabled: true })
    expect(step(model, 'push').reason).toContain('no remote')
    expect(step(model, 'create_pull_request').disabled).toBe(true)
    expect(model.sync).toEqual({ disabled: true, reason: 'This project has no remote.' })
  })

  test('the commit steps still need uncommitted changes', () => {
    expect(step(gitPublishModel(status(), LOCAL_ONLY), 'commit_with_options')).toMatchObject({
      disabled: true,
      reason: 'There are no uncommitted changes.',
    })
  })
})

describe('gitPublishModel — no repository', () => {
  test('every action is disabled with one reason', () => {
    const model = gitPublishModel(status(), {
      repository: repository({ isRepository: false, hasCommits: false, branch: null, primaryRemoteName: null, primaryRemoteUrl: null }),
      githubConnected: null,
    })
    expect(model.readiness).toBe('no-repository')
    expect(model.commit.primary).toMatchObject({ kind: 'disabled' })
    expect(model.pullRequest.primary).toMatchObject({ kind: 'disabled' })
    for (const entry of [...model.commit.steps, ...model.pullRequest.steps]) {
      expect(entry).toMatchObject({ disabled: true, reason: 'This folder is not a Git repository.' })
    }
  })

  test('a missing git status disables everything even before the probe answers', () => {
    const model = gitPublishModel(null)
    expect(model.commit.primary).toMatchObject({ kind: 'disabled', reason: 'Git status is unavailable.' })
    expect(model.sync.disabled).toBe(true)
  })
})

// The two rows report the run in the order it works: a user who asked to commit
// and push should not see the pull-request row claim to be busy before the run
// has reached the pull request at all.
describe('isPullRequestRunning', () => {
  test('a commit or push never lights the pull-request row', () => {
    expect(isPullRequestRunning('commit', 'commit')).toBe(false)
    expect(isPullRequestRunning('commit_push', 'push')).toBe(false)
  })

  test('the combined action waits for its pull-request phases', () => {
    expect(isPullRequestRunning('commit_push_pull_request', 'commit')).toBe(false)
    expect(isPullRequestRunning('commit_push_pull_request', 'push')).toBe(false)
    expect(isPullRequestRunning('commit_push_pull_request', 'author_pull_request')).toBe(true)
    expect(isPullRequestRunning('commit_push_pull_request', 'create_pull_request')).toBe(true)
  })

  // Opening a pull request pushes on the way, and that push is this row's work.
  test('opening a pull request lights the row for every phase', () => {
    expect(isPullRequestRunning('create_pull_request', null)).toBe(true)
    expect(isPullRequestRunning('create_pull_request', 'push')).toBe(true)
  })

  test('nothing runs when no action runs', () => {
    expect(isPullRequestRunning(null, null)).toBe(false)
  })
})
