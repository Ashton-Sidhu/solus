import { describe, expect, test } from 'bun:test'
import type { PullRequestSummary } from '../../src/shared/providers'
import { attachReviewAttention } from '../../src/main/server/handlers/review-attention'
import { needsReviewSearchTerms } from '../../src/main/providers/github/provider'

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 1,
    title: 'Review me',
    headSha: 'head-1',
    author: 'author',
    authorAvatarUrl: '',
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
    ...overrides,
  }
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
