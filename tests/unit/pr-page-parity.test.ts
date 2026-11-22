import { PERSONAL_SETTING_KEYS, EXECUTION_PREFERENCE_KEYS } from '@solus/contracts/settings'
import { describe, expect, test } from 'bun:test'
import {
  PR_SORT_OPTIONS,
  prSavedViewsSchema,
  putPrSavedView,
  type PrSavedView
} from '@solus/contracts/pr-views'
import { togglePrLabel } from '@solus/client-core/pr-label-filters'
import { comparePrs } from '@solus/client-core/pr-sort'
import { capturePrView, applyPrView } from '@solus/workspace-ui/components/prs/lib/pr-saved-views'
import { emptyListView } from '@solus/workspace-ui/components/prs/lib/prs-list-view'
import { filterPrFacets } from '@solus/workspace-ui/components/prs/lib/pr-utils'
import {
  applyPrView as applyNativeView,
  capturePrView as captureNativeView
} from '../../apps/mobile/solus-core/features/prs/lib/pr-saved-views'
import {
  filterPullRequestRows,
  type PullRequestRow
} from '../../apps/mobile/solus-core/features/prs/lib/pull-request-list'
import { resolvePullRequestListScope } from '../../apps/mobile/solus-core/features/workspace/list-preferences'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { PullRequest } from '@solus/contracts/providers'

const saved: PrSavedView = {
  id: 'queue',
  name: 'Ready bug fixes',
  filters: {
    hostId: 'host-a',
    project: { hostId: 'host-a', projectPath: '/work/repo' },
    query: 'fix',
    state: 'merged',
    involvement: 'assigned',
    labels: [['bug', 'fix'], ['small']],
    excludedLabels: ['hold'],
    author: 'ada',
    draft: 'hide',
    review: 'approved',
    checks: 'passing',
    sort: 'smallest',
    guide: true,
    lens: true
  }
}
const row = (pr: PullRequest): PullRequestRow => ({
  hostId: 'host-a',
  projectPath: '/work/repo',
  folderName: 'repo',
  pr,
  checks: pr.checksState ?? null
})

describe('personal PR views across clients', () => {
  test('restores every filter on web and native, including OR groups and host scope', () => {
    const view = emptyListView()
    applyPrView(view, saved.filters)
    expect(capturePrView(view, saved.filters.hostId, saved.filters.project)).toEqual(saved.filters)
    const native = applyNativeView(saved.filters)
    expect(captureNativeView(native, saved.filters.query)).toEqual(saved.filters)
    const scope = resolvePullRequestListScope(native, ['host-a', 'host-b'])
    expect(scope.hostIds).toEqual(['host-a'])
    expect(scope.controls.state).toBe('merged')
    // Editing applied controls must never modify the stored view.
    view.labelGroups![0]!.push('changed')
    native.filters.excludedLabels!.push('changed')
    expect(saved.filters.labels[0]).toEqual(['bug', 'fix'])
    expect(saved.filters.excludedLabels).toEqual(['hold'])
  })
  test('a legacy drafts-only state is saved as open plus drafts only', () => {
    const view = emptyListView()
    view.statusKeys = ['draft']
    expect(capturePrView(view, null, null)).toMatchObject({ state: 'open', draft: 'only' })
  })
  test('rename keeps identity and filters; malformed or excessive synced data is refused', () => {
    expect(putPrSavedView([saved], { ...saved, name: 'Renamed' })).toEqual([
      { ...saved, name: 'Renamed' }
    ])
    expect(prSavedViewsSchema.safeParse([saved, saved]).success).toBe(false)
    expect(prSavedViewsSchema.safeParse([{ ...saved, name: ' ' }]).success).toBe(false)
    expect(
      prSavedViewsSchema.safeParse(
        Array.from({ length: 51 }, (_, index) => ({ ...saved, id: String(index) }))
      ).success
    ).toBe(false)
  })
  test('include groups mean AND of ORs, exclusions override matches on both clients', () => {
    const prs = [
      pullRequestFixture(1, { labels: ['bug', 'small'].map((name) => ({ name, color: '' })) }),
      pullRequestFixture(2, { labels: ['fix', 'small'].map((name) => ({ name, color: '' })) }),
      pullRequestFixture(3, { labels: ['bug'].map((name) => ({ name, color: '' })) }),
      pullRequestFixture(4, {
        labels: ['bug', 'small', 'hold'].map((name) => ({ name, color: '' }))
      })
    ]
    expect(
      filterPrFacets(
        prs,
        {
          ...emptyListView(),
          labelGroups: saved.filters.labels,
          excludedLabels: saved.filters.excludedLabels
        },
        { viewerLogin: () => null, checksState: () => null }
      ).map((pr) => pr.number)
    ).toEqual([1, 2])
    const native = filterPullRequestRows(
      prs.map(row),
      {
        involvement: 'all',
        filters: { labels: saved.filters.labels, excludedLabels: saved.filters.excludedLabels },
        sort: 'updated'
      },
      () => null
    )
    expect(native.map((item) => item.pr.number)).toEqual([1, 2])
  })
  test('Merged and Closed select different native rows, and assignment follows the host viewer', () => {
    const rows = [
      row(pullRequestFixture(1, { state: 'merged', assignees: ['ADA'] })),
      row(pullRequestFixture(2, { state: 'closed' })),
      row(pullRequestFixture(3))
    ]
    const controls = { involvement: 'all' as const, filters: {}, sort: 'updated' as const }
    expect(
      filterPullRequestRows(rows, { ...controls, state: 'merged' }, () => 'ada').map(
        (item) => item.pr.number
      )
    ).toEqual([1])
    expect(
      filterPullRequestRows(rows, { ...controls, state: 'closed' }, () => 'ada').map(
        (item) => item.pr.number
      )
    ).toEqual([2])
    expect(
      filterPullRequestRows(rows, { ...controls, involvement: 'assigned' }, () => 'ada').map(
        (item) => item.pr.number
      )
    ).toEqual([1])
    expect(
      filterPullRequestRows(rows, { ...controls, involvement: 'assigned' }, () => null)
    ).toEqual([])
  })
})
describe('shared PR queue ordering', () => {
  const facts = (pr: PullRequest) => ({ viewerLogin: 'ada', checks: pr.checksState ?? null })
  test('blocked on me prioritizes open review requests and authored failures without guessing the viewer', () => {
    const prs = [
      pullRequestFixture(1),
      pullRequestFixture(2, { author: 'ADA', checksState: 'failing' }),
      pullRequestFixture(3, { requestedReviewers: [{ login: 'Ada' }] }),
      pullRequestFixture(4, { author: 'ada', mergeable: false }),
      pullRequestFixture(5, { author: 'ada', reviewStatus: 'changes-requested' }),
      pullRequestFixture(6, { state: 'merged', needsMyReview: true })
    ]
    expect(
      prs.toSorted((a, b) => comparePrs(a, b, 'blocked', facts)).map((pr) => pr.number)
    ).toEqual([2, 3, 4, 5, 1, 6])
    expect(
      prs
        .toSorted((a, b) =>
          comparePrs(a, b, 'blocked', () => ({ viewerLogin: null, checks: 'failing' }))
        )
        .map((pr) => pr.number)
    ).toEqual([1, 2, 3, 4, 5, 6])
  })
  test('native and workspace sorts give the same order, with unknown size after measured diffs', () => {
    const prs = [
      pullRequestFixture(1, { updatedAt: '2026-02-01', createdAt: '2026-02-01' }),
      pullRequestFixture(2, { additions: 100, checksState: 'passing', reviewStatus: 'approved' }),
      pullRequestFixture(3, { additions: 2, checksState: 'passing', reviewStatus: 'approved' }),
      pullRequestFixture(4, { additions: 1, mergeable: false })
    ]
    for (const { value } of PR_SORT_OPTIONS) {
      const expected = prs.toSorted((a, b) => comparePrs(a, b, value, facts)).map((pr) => pr.number)
      expect(
        filterPullRequestRows(
          prs.map(row),
          { involvement: 'all', filters: {}, sort: value },
          () => 'ada'
        ).map((item) => item.pr.number)
      ).toEqual(expected)
    }
    expect(
      prs.toSorted((a, b) => comparePrs(a, b, 'smallest', facts)).map((pr) => pr.number)
    ).toEqual([4, 3, 2, 1])
    expect(prs.toSorted((a, b) => comparePrs(a, b, 'ready', facts)).map((pr) => pr.number)).toEqual(
      [3, 2, 1, 4]
    )
  })
})

test('changing a label keeps every other OR group intact', () => {
  const groups = [['bug', 'fix'], ['small']]
  expect(togglePrLabel(groups, 'docs')).toEqual([['bug', 'fix'], ['small'], ['docs']])
  expect(togglePrLabel(groups, 'BUG')).toEqual([['fix'], ['small']])
  expect(groups).toEqual([['bug', 'fix'], ['small']])
})

test('saved PR views are personal preferences, never agent execution preferences', () => {
  expect(PERSONAL_SETTING_KEYS).toContain('prSavedViews')
  expect(EXECUTION_PREFERENCE_KEYS).not.toContain('prSavedViews')
})
