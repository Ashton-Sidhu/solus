import { describe, expect, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { attachReviewAttention } from '@solus/server/server/handlers/review-attention'
import { needsReviewSearchTerms } from '@solus/server/providers/github/provider'

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return pullRequestFixture(1, { title: 'Review me', author: 'author', ...overrides })
}

describe('review attention', () => {
  test('asks GitHub only for PRs that need the viewer instead of scanning every open PR', () => {
    expect(needsReviewSearchTerms(
      { host: 'github.com', owner: 'acme', repo: 'app' },
      'viewer',
    )).toEqual({
      requestedQuery: 'repo:acme/app is:pr is:open review-requested:viewer',
      assignedQuery: 'repo:acme/app is:pr is:open assignee:viewer',
    })
  })

  test('keeps current and repeated review requests impossible to miss', () => {
    const [result] = attachReviewAttention([pr({ requestedReviewers: ['Viewer'] })], 'viewer')

    expect(result.needsMyReview).toBe(true)
    expect(result.reviewAttention).toBe('requested')
  })

  test('includes assignments but does not ask authors to review their own PR', () => {
    const [assigned, own] = attachReviewAttention([
      pr({ number: 1, assignees: ['viewer'] }),
      pr({ number: 2, author: 'viewer', requestedReviewers: ['viewer'] }),
    ], 'viewer')

    expect(assigned.reviewAttention).toBe('assigned')
    expect(own.needsMyReview).toBeUndefined()
  })

  test('ignores stale requests on closed PRs', () => {
    const [result] = attachReviewAttention([
      pr({ state: 'closed', requestedReviewers: ['viewer'] }),
    ], 'viewer')

    expect(result.needsMyReview).toBeUndefined()
  })
})
