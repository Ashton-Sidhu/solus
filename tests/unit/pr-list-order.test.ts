import { describe, expect, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { rankPrsByMergeReadiness, type PrChecksState } from '@solus/workspace-ui/components/prs/lib/pr-utils'
import { arrangePrList } from '@solus/workspace-ui/components/prs/lib/pr-list-arrange'
import { parsePrSearchQuery } from '@solus/workspace-ui/components/prs/lib/pr-search-query'
import { emptyListView, prSections, type PrRowContext } from '@solus/workspace-ui/components/prs/lib/prs-list-view'

function pr(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return pullRequestFixture(number, { additions: 10, deletions: 0, updatedAt: '2026-09-01T00:00:00Z', ...overrides })
}

describe('merge readiness order', () => {
  const checks = new Map<number, PrChecksState>()
  const checksState = (item: PullRequest) => checks.get(item.number) ?? null

  test('green and approved first, then green, then other open work, then finished, then conflicts', () => {
    // WHY: the default queue is "what can I land next". A conflict is never
    // ready whatever its checks and review say, so it sinks below even
    // finished work; a draft is open work its author has not made ready.
    const conflicted = pr(1, { mergeable: false, reviewStatus: 'approved' })
    const merged = pr(2, { state: 'merged' })
    const draft = pr(3, { draft: true })
    const failing = pr(4)
    const passing = pr(5)
    const ready = pr(6, { reviewStatus: 'approved' })
    checks.set(1, 'passing')
    checks.set(4, 'failing')
    checks.set(5, 'passing')
    checks.set(6, 'passing')

    const order = rankPrsByMergeReadiness([conflicted, merged, draft, failing, passing, ready], checksState)
    expect(order.map((item) => item.number)).toEqual([6, 5, 3, 4, 2, 1])
  })

  test('inside a tier the smaller diff wins, an unknown size goes last, and recency breaks ties', () => {
    // WHY: small green changes are the quickest to land; a row whose size the
    // host has not reported yet cannot claim to be small.
    const large = pr(1, { additions: 400, deletions: 100 })
    const small = pr(2, { additions: 5, deletions: 5 })
    const unknown = pr(3, { additions: 0, deletions: 0 })
    const smallNewer = pr(4, { additions: 6, deletions: 4, updatedAt: '2026-09-02T00:00:00Z' })
    expect(rankPrsByMergeReadiness([unknown, large, small, smallNewer], () => null).map((item) => item.number))
      .toEqual([4, 2, 1, 3])
  })
})

describe('pull request sections', () => {
  const context: Pick<PrRowContext, 'isMine' | 'isReviewRequested'> = {
    isMine: (item) => item.author === 'sidhu',
    isReviewRequested: (item) => !!item.requestedReviewers?.some((reviewer) => reviewer.login === 'sidhu'),
  }

  test('authored comes first, then review requested, then everything else; yours wins over requested', () => {
    // WHY: work you own is the work you move; a pull request that is yours and
    // also asks for your review is still yours, and must not be listed twice.
    const others = pr(1, { author: 'alex' })
    const requested = pr(2, { author: 'alex', needsMyReview: true })
    const requestedByList = pr(3, { author: 'alex', requestedReviewers: [{ login: 'sidhu' }] })
    const both = pr(4, { author: 'sidhu', requestedReviewers: [{ login: 'sidhu' }], needsMyReview: true })

    const sections = prSections([others, requested, requestedByList, both], context)
    expect(sections.map((section) => [section.label, section.prs.map((item) => item.number)])).toEqual([
      ['Authored', [4]],
      ['Review requested', [2, 3]],
      ['Others', [1]],
    ])
  })

  test('sections only split the unnarrowed list, and keep the chosen order inside each', () => {
    // WHY: a search is ordered by relevance and a list narrowed to one
    // involvement would be one section anyway — both read as one flat list.
    const facts = {
      rowContext: { checks: () => undefined, ...context },
      viewerLogin: () => 'sidhu',
      checksState: () => null,
      hasGuide: () => false,
      hasLens: () => false,
    }
    const items = [
      pr(1, { author: 'alex', createdAt: '2026-01-02T00:00:00Z' }),
      pr(2, { author: 'sidhu', createdAt: '2026-01-01T00:00:00Z' }),
      pr(3, { author: 'alex', createdAt: '2026-01-03T00:00:00Z' }),
    ]
    const search = { typed: parsePrSearchQuery(''), hostAnswered: true }
    const listView = { ...emptyListView(), sortMode: 'created' as const }

    const unnarrowed = arrangePrList(items, listView, search, facts)
    expect(unnarrowed.sectioned).toBe(true)
    expect(unnarrowed.sections.map((section) => section.prs.map((item) => item.number))).toEqual([[2], [3, 1]])

    const involved = arrangePrList(items, { ...listView, involvement: 'created' }, search, facts)
    expect(involved.sectioned).toBe(false)
    expect(involved.sections.map((section) => section.key)).toEqual(['all'])

    const searching = arrangePrList(items, { ...listView, query: 'PR' }, { typed: parsePrSearchQuery('PR'), hostAnswered: false }, facts)
    expect(searching.sectioned).toBe(false)
  })

  test('until the host answers a search, the rows on screen are narrowed by the typed text', () => {
    // WHY: the list keeps its rows while the search is on its way rather than
    // showing a skeleton, so those rows must already match what was typed.
    // Once the host has answered, its matches stand even where the row does
    // not show the matching words (the host also reads bodies).
    const facts = {
      rowContext: { checks: () => undefined, isMine: () => false },
      viewerLogin: () => null,
      checksState: () => null,
      hasGuide: () => false,
      hasLens: () => false,
    }
    const items = [pr(1, { title: 'Fix login' }), pr(2, { title: 'Docs' })]
    const listView = { ...emptyListView(), query: 'login' }
    const typed = parsePrSearchQuery('login')
    expect(arrangePrList(items, listView, { typed, hostAnswered: false }, facts).filtered.map((item) => item.number)).toEqual([1])
    expect(arrangePrList(items, listView, { typed, hostAnswered: true }, facts).filtered.map((item) => item.number)).toEqual([1, 2])
  })
})

describe('PR list defaults', () => {
  test('opens on merge readiness, showing open work with drafts', () => {
    // WHY: the page is a review queue first; drafts stay visible by default
    // and are ranked below ready work rather than hidden.
    expect(emptyListView().sortMode).toBe('ready')
    expect(emptyListView().statusKeys).toEqual(['open', 'draft'])
  })
})
