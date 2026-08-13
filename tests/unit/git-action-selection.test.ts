import { describe, expect, test } from 'bun:test'
import { primaryGitAction } from '../../src/renderer/components/project-panel/lib/git-action-selection'
import type { GitState } from '../../src/shared/types'

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

describe('primaryGitAction', () => {
  test('moves dirty default-branch work to a feature branch before opening a PR', () => {
    expect(primaryGitAction(status({
      branch: 'main',
      targetBranch: 'main',
      uncommittedChanges: {
        files: [{ path: 'src/git.ts', conflicted: false }],
        hasMoreFiles: false,
        insertions: 4,
        deletions: 0,
        mergeInProgress: false,
      },
    }))).toEqual({
      kind: 'run',
      label: 'Create feature branch and open PR',
      action: 'commit_push_pull_request',
      createFeatureBranch: true,
    })
  })

  test('opens a PR from a clean feature branch with unpublished commits', () => {
    expect(primaryGitAction(status({ upstreamRef: null, aheadCount: 0 }))).toEqual({
      kind: 'run',
      label: 'Push and open PR',
      action: 'create_pull_request',
    })
  })

  test('returns the existing PR when the branch is fully published', () => {
    expect(primaryGitAction(status({
      prUrl: 'https://github.com/solus-sh/solus/pull/42',
      targetAheadCount: 2,
    }))).toEqual({
      kind: 'view',
      label: 'View pull request',
      url: 'https://github.com/solus-sh/solus/pull/42',
    })
  })

  test('blocks publishing when the branch is behind its upstream', () => {
    expect(primaryGitAction(status({ behindCount: 2 }))).toMatchObject({
      kind: 'disabled',
      label: 'Sync before publishing',
    })
  })
})
