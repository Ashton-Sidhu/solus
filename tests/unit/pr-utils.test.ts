import { describe, expect, test } from 'bun:test'
import type { PullRequestSummary } from '../../src/shared/providers'
import { filterPrs, reviewEffortSummary, sortPrs } from '../../src/renderer/components/prs/lib/pr-utils'
import type { ReviewEffort } from '../../src/shared/effort-types'

function pr(number: number, state: PullRequestSummary['state'], effort?: ReviewEffort): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    headSha: `head-${number}`,
    author: 'sidhu',
    authorAvatarUrl: '',
    state,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
    effort,
  }
}

describe('filterPrs', () => {
  test('shows merged pull requests in the closed filter', () => {
    const items = [pr(1, 'open'), pr(2, 'closed'), pr(3, 'merged')]

    expect(filterPrs(items, '', 'closed').map((item) => item.number)).toEqual([2, 3])
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
