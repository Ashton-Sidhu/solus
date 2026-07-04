import { describe, expect, test } from 'bun:test'
import type { PullRequestSummary } from '../../src/shared/providers'
import { filterPrs } from '../../src/renderer/components/prs/lib/pr-utils'

function pr(number: number, state: PullRequestSummary['state']): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    author: 'sidhu',
    authorAvatarUrl: '',
    state,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
  }
}

describe('filterPrs', () => {
  test('shows merged pull requests in the closed filter', () => {
    const items = [pr(1, 'open'), pr(2, 'closed'), pr(3, 'merged')]

    expect(filterPrs(items, '', 'closed').map((item) => item.number)).toEqual([2, 3])
  })
})
