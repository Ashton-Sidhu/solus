import { describe, expect, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { arrangePrList } from '@solus/workspace-ui/components/prs/lib/pr-list-arrange'
import { parsePrSearchQuery } from '@solus/workspace-ui/components/prs/lib/pr-search-query'
import { emptyListView, prSections, type PrRowContext } from '@solus/workspace-ui/components/prs/lib/prs-list-view'

function pr(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return pullRequestFixture(number, { additions: 10, deletions: 0, updatedAt: '2026-09-01T00:00:00Z', ...overrides })
}

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
      rowContext: context,
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
      rowContext: { isMine: () => false },
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
  test('opens on Recently updated, showing open work with drafts', () => {
    // WHY: the list sorts as T3 Code does on every client, so desktop, web,
    // and the phone open on the same order.
    expect(emptyListView().sortMode).toBe('updated')
    expect(emptyListView().statusKeys).toEqual(['open', 'draft'])
  })
})
