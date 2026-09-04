import { describe, expect, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { filterPrFacets, filterPrs, prStatusBadge, reviewEffortSummary, sortPrs } from '@solus/workspace-ui/components/prs/lib/pr-utils'
import type { ReviewEffort } from '@solus/contracts/effort-types'

function pr(number: number, state: PullRequest['state'], effort?: ReviewEffort): PullRequest {
  return pullRequestFixture(number, { author: 'sidhu', state, effort })
}

describe('filterPrs', () => {
  test('shows merged pull requests in the closed filter', () => {
    const items = [pr(1, 'open'), pr(2, 'closed'), pr(3, 'merged')]

    expect(filterPrs(items, '', 'closed').map((item) => item.number)).toEqual([2, 3])
  })
})

describe('pull request facet filters', () => {
  const selection = {
    involvement: 'all' as const,
    author: null,
    label: null,
    draft: 'all' as const,
    review: 'all' as const,
    checks: 'all' as const,
  }
  const context = {
    viewerLogin: () => 'sidhu',
    checksState: (item: PullRequest) => item.number === 1 ? 'passing' as const : 'failing' as const,
  }
  const items = [
    pullRequestFixture(1, {
      author: 'sidhu',
      labels: [{ name: 'bug', color: 'f00' }],
      assignees: ['sidhu'],
      requestedReviewers: [{ login: 'alex' }],
    }),
    pullRequestFixture(2, {
      author: 'alex',
      draft: true,
      labels: [{ name: 'docs', color: '00f' }],
      requestedReviewers: [{ login: 'sidhu' }],
      reviewAttention: 'requested',
      reviewStatus: 'review-required',
    }),
  ]

  test('narrows on each facet without treating missing viewer facts as a match', () => {
    // WHY: each row in the menu must change the list, not only reproduce the
    // reference's appearance. The current viewer can vary by host in the inbox.
    expect(filterPrFacets(items, { ...selection, involvement: 'created' }, context).map((item) => item.number)).toEqual([1])
    expect(filterPrFacets(items, { ...selection, involvement: 'review-requested' }, context).map((item) => item.number)).toEqual([2])
    expect(filterPrFacets(items, { ...selection, author: 'alex' }, context).map((item) => item.number)).toEqual([2])
    expect(filterPrFacets(items, { ...selection, label: 'bug' }, context).map((item) => item.number)).toEqual([1])
    expect(filterPrFacets(items, { ...selection, draft: 'draft' }, context).map((item) => item.number)).toEqual([2])
    expect(filterPrFacets(items, { ...selection, review: 'review-required' }, context).map((item) => item.number)).toEqual([2])
    expect(filterPrFacets(items, { ...selection, checks: 'passing' }, context).map((item) => item.number)).toEqual([1])
    expect(filterPrFacets(items, { ...selection, involvement: 'created' }, { ...context, viewerLogin: () => null })).toEqual([])
  })
})

describe('pull request status colours', () => {
  test('uses conventional Git host lifecycle colours', () => {
    // WHY: PR state follows the familiar Git host convention. In particular,
    // open must read as green rather than the blue used for active task work.
    expect(prStatusBadge({ state: 'open', draft: false })?.tone).toBe('var(--success)')
    expect(prStatusBadge({ state: 'merged', draft: false })?.tone).toBe('var(--review)')
    expect(prStatusBadge({ state: 'closed', draft: false })?.tone).toBe('var(--failure)')
  })
})

describe('review effort pacing', () => {
  test('orders known reading effort smallest first without hiding unknown PRs', () => {
    const items = [
      pr(1, 'open', { band: 'involved', minutes: 12, signals: ['large'] }),
      pr(2, 'open'),
      pr(3, 'open', { band: 'quick', minutes: 1, signals: ['tiny'] }),
    ]

    expect(sortPrs(items, 'effort').map((item) => item.number)).toEqual([3, 1, 2])
  })

  test('totals known estimates while keeping the listed PR count honest', () => {
    const items = [
      pr(1, 'open', { band: 'quick', minutes: 1, signals: ['tiny'] }),
      pr(2, 'open'),
      pr(3, 'open', { band: 'standard', minutes: 4, signals: ['medium'] }),
    ]

    expect(reviewEffortSummary(items)).toEqual({ count: 3, knownCount: 2, minutes: 5 })
  })
})
