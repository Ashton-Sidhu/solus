import { describe, expect, test } from 'bun:test'
import { publishStepStates, primaryGitAction } from '../../src/renderer/components/project-panel/lib/git-action-selection'
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

describe('publishStepStates', () => {
  function stepFor(state: Parameters<typeof publishStepStates>[0], key: string) {
    const step = publishStepStates(state).find((candidate) => candidate.key === key)
    if (!step) throw new Error(`no step ${key}`)
    return step
  }

  test('offers each publish step of the bundled action in order', () => {
    expect(publishStepStates(status()).map((step) => step.key)).toEqual(['push', 'create_pull_request'])
  })

  test('push counts against the target branch until the branch has an upstream', () => {
    // Never published: the commits ahead of the target are what a push carries.
    expect(stepFor(status({ upstreamRef: null, aheadCount: 0, targetAheadCount: 2 }), 'push').disabled).toBe(false)
    expect(stepFor(status({ upstreamRef: null, aheadCount: 0, targetAheadCount: 0 }), 'push').disabled).toBe(true)
    // Published: only what the upstream is missing counts.
    expect(stepFor(status({ aheadCount: 0, targetAheadCount: 3 }), 'push').disabled).toBe(true)
    expect(stepFor(status({ aheadCount: 1 }), 'push').disabled).toBe(false)
  })

  test('push waits for a sync while the branch is behind', () => {
    expect(stepFor(status({ aheadCount: 2, behindCount: 1 }), 'push')).toMatchObject({
      disabled: true,
      reason: 'The branch is behind its upstream — sync first.',
    })
  })

  test('a branch with a pull request cannot open a second one', () => {
    expect(stepFor(status({ prUrl: 'https://github.com/solus-sh/solus/pull/42' }), 'create_pull_request')).toMatchObject({
      disabled: true,
      reason: 'This branch already has a pull request.',
    })
    expect(stepFor(status(), 'create_pull_request').disabled).toBe(false)
  })

  test('the default branch has nothing to open a pull request from', () => {
    expect(stepFor(status({ branch: 'main' }), 'create_pull_request').disabled).toBe(true)
  })

  test('every step is disabled with a reason on a detached HEAD', () => {
    for (const step of publishStepStates(status({ branch: null }))) {
      expect(step.disabled).toBe(true)
      expect(step.reason).toBe('Detached HEAD cannot publish.')
    }
  })
})
