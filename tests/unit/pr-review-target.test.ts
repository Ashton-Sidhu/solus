import { describe, expect, test } from 'bun:test'
import { buildPrReviewTarget } from '../../src/main/providers/pr-review-target'
import type { PullRequestDetail } from '../../src/shared/providers'

describe('pull request review target', () => {
  test('contains the exact host revision and no checkout state', () => {
    // WHY: opening Activity and Diff is read-only. A local path in this DTO
    // would let route resolution silently make checkout a prerequisite again.
    const detail = {
      number: 42,
      title: 'Read from the host',
      baseRef: 'main',
      headRef: 'feature',
      baseSha: 'base-tip',
      headSha: 'head-sha',
      headRepo: { owner: 'octo', repo: 'repo', isFork: false },
    } as PullRequestDetail

    const target = buildPrReviewTarget(
      { host: 'github.com', owner: 'octo', repo: 'repo' },
      detail,
      'merge-base-sha',
    )

    expect(target).toEqual({
      host: 'github.com',
      owner: 'octo',
      repo: 'repo',
      number: 42,
      title: 'Read from the host',
      baseRef: 'main',
      headRef: 'feature',
      baseSha: 'merge-base-sha',
      headSha: 'head-sha',
      headRepo: { owner: 'octo', repo: 'repo', isFork: false },
    })
    expect('worktreePath' in target).toBe(false)
    expect('branch' in target).toBe(false)
  })
})
