import { describe, expect, it } from 'bun:test'
import type { GitState } from '@solus/contracts/types'
import {
  mobileBranchLabel,
  mobileChangesSummary,
  mobileCurrentBranch,
  mobilePullRequestRow,
} from '../../apps/client/src/shell/mobile/lib/mobile-branch'

/**
 * A phone has no project rail, so the navbar line and the task sheet card are
 * the only places that say which branch a session is on, what is uncommitted
 * on it, and whether a pull request already stands for it. These pin the three
 * readings so a wrong answer cannot hide behind a small font.
 */

function status(overrides: Partial<GitState> = {}): GitState {
  return {
    repoRoot: '/repo',
    headSha: 'abc',
    branch: 'feature/mobile',
    targetBranch: 'main',
    uncommittedChanges: { files: [], hasMoreFiles: false, insertions: 0, deletions: 0, mergeInProgress: false },
    upstreamRef: null,
    aheadCount: 0,
    behindCount: 0,
    ...overrides,
  }
}

describe('the branch a phone prints', () => {
  it('prefers what Git reports now over the branch the session started on', () => {
    // A `git switch` inside the session must show on the phone the same frame
    // it shows in the desktop rail, not the checkout captured at start.
    expect(mobileCurrentBranch({ branch: 'old', status: status({ branch: 'new' }), isolated: false })).toBe('new')
    expect(mobileCurrentBranch({ branch: 'old', status: undefined, isolated: false })).toBe('old')
  })

  it('drops the worktree prefix, and says nothing outside a repository', () => {
    expect(mobileBranchLabel({ branch: 'solus/feature-x', status: undefined, isolated: true })).toBe('feature-x')
    expect(mobileBranchLabel({ branch: null, status: null, isolated: false })).toBeNull()
    expect(mobileBranchLabel({ branch: null, status: status({ branch: null }), isolated: false })).toBe('detached HEAD')
  })
})

describe('the uncommitted-changes summary', () => {
  it('stays silent until status has answered, then reports a clean tree as such', () => {
    // An empty string, not "None": a row that says the tree is clean before
    // Git has been read is lying.
    expect(mobileChangesSummary(undefined)).toBe('')
    expect(mobileChangesSummary(status())).toBe('None')
  })

  it('counts files and keeps only the non-zero stats', () => {
    const one = status({
      uncommittedChanges: { files: [{ path: 'a', conflicted: false }], hasMoreFiles: false, insertions: 4, deletions: 0, mergeInProgress: false },
    })
    expect(mobileChangesSummary(one)).toBe('1 file +4')
    const truncated = status({
      uncommittedChanges: { files: [{ path: 'a', conflicted: false }, { path: 'b', conflicted: false }], hasMoreFiles: true, insertions: 12, deletions: 3, mergeInProgress: false },
    })
    expect(mobileChangesSummary(truncated)).toBe('2+ files +12 −3')
  })
})

describe('the pull request row', () => {
  it('says "open" only once the store has described an open pull request', () => {
    // Host discovery answers for merged branches too, so the URL on status is
    // evidence of a pull request, never of an open one.
    expect(mobilePullRequestRow(status({ prUrl: 'https://github.com/o/r/pull/12' }), null)).toEqual({
      kind: 'linked',
      number: 12,
      url: 'https://github.com/o/r/pull/12',
    })
    expect(
      mobilePullRequestRow(status({ prUrl: 'https://github.com/o/r/pull/12' }), {
        number: 12,
        title: 'Show branch on mobile',
        draft: true,
        state: 'open',
      }),
    ).toEqual({ kind: 'open', number: 12, title: 'Show branch on mobile', draft: true })
  })

  it('names a merged pull request without calling it open', () => {
    expect(
      mobilePullRequestRow(status({ prUrl: 'https://github.com/o/r/pull/12' }), {
        number: 12,
        title: 'Landed',
        draft: false,
        state: 'merged',
      }),
    ).toEqual({ kind: 'linked', number: 12, url: 'https://github.com/o/r/pull/12' })
  })

  it('keeps a non-GitHub link openable without inventing a number', () => {
    expect(mobilePullRequestRow(status({ prUrl: 'https://gitlab.com/o/r/-/merge_requests/3' }), null)).toEqual({
      kind: 'linked',
      number: null,
      url: 'https://gitlab.com/o/r/-/merge_requests/3',
    })
  })

  it('reports no pull request when neither the host nor the store names one', () => {
    expect(mobilePullRequestRow(status(), null)).toEqual({ kind: 'none' })
    expect(mobilePullRequestRow(undefined, null)).toEqual({ kind: 'none' })
  })
})
