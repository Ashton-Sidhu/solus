import { describe, expect, test } from 'bun:test'
import type { PrProjectListing } from '@solus/contracts/providers'
import { PullRequestDirectory, type HostPullRequests } from '../../apps/mobile/src/features/prs/pull-request-directory'
import {
  DEFAULT_PULL_REQUEST_LIST_CONTROLS, filterPullRequestRows, pullRequestLabelColor, pullRequestListFacets,
  pullRequestRowKey, pullRequestRowReviewStatus, pullRequestRows, type PullRequestRow,
} from '../../apps/mobile/src/features/prs/lib/pull-request-list'
import { shownValue } from '../../apps/mobile/src/features/prs/pull-request-reads'
import { FakeApi } from './helpers/native-mobile-fakes'
import { hostWorld, project, pullRequest } from './helpers/native-mobile-prs-fixtures'

// The Pull Requests tab shows every host at once. These tests pin what the
// person relies on: the filters they chose narrow the rows the same way on
// every host, "mine" means the account of the host that listed the row, and
// one repository on two hosts shows once.

const row = (number: number, overrides: Partial<PullRequestRow> & { pr?: Parameters<typeof pullRequest>[1] } = {}): PullRequestRow => ({
  hostId: overrides.hostId ?? 'a',
  projectPath: overrides.projectPath ?? '/work/app',
  folderName: 'app',
  checks: overrides.checks ?? null,
  pr: pullRequest(number, { updatedAt: `2026-10-${String(number).padStart(2, '0')}T00:00:00Z`, ...overrides.pr }),
})

const viewers = (map: Record<string, string>) => (hostId: string) => map[hostId] ?? null

describe('pull request list filters (ported from T3 pullRequestList.test.ts)', () => {
  test('combines label groups, exclusions, draft and review filters', () => {
    const rows = [
      row(1, { pr: { labels: [{ name: 'size:XS', color: '' }, { name: 'bug', color: '' }], reviewStatus: 'approved' } }),
      row(2, { pr: { draft: true, labels: [{ name: 'bug', color: '' }] } }),
      row(3, { pr: { labels: [{ name: 'feature', color: '' }] } }),
    ]
    const filters = { draft: 'hide' as const, review: 'approved' as const, labels: [['SIZE:XS', 'size:S'], ['bug']], excludedLabels: ['feature'] }
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, filters }, viewers({})).map((r) => r.pr.number)).toEqual([1])
  })

  test('authored and author:me follow the account of each host, not one account for all', () => {
    const rows = [row(1, { pr: { author: 'Octocat' } }), row(2, { hostId: 'b', pr: { author: 'octocat', baseRepo: { host: 'github.com', owner: 'o', repo: 'other' } } })]
    const accounts = viewers({ a: 'octocat', b: 'someone-else' })
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, involvement: 'authored' }, accounts).map((r) => r.pr.number)).toEqual([1])
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, filters: { author: 'me' } }, accounts).map((r) => r.pr.number)).toEqual([1])
  })

  test('review requested and others split what is not authored', () => {
    const rows = [row(1, { pr: { author: 'me' } }), row(2, { pr: { needsMyReview: true } }), row(3)]
    const me = viewers({ a: 'me' })
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, involvement: 'reviewing' }, me).map((r) => r.pr.number)).toEqual([2])
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, involvement: 'others' }, me).map((r) => r.pr.number)).toEqual([3])
  })

  test('a host without a review summary or checks is not hidden by those filters', () => {
    const rows = [row(1), row(2, { checks: 'failing' }), row(3, { checks: 'passing' })]
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, filters: { review: 'approved' } }, viewers({}))).toHaveLength(3)
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, filters: { checks: 'passing' } }, viewers({})).map((r) => r.pr.number)).toEqual([3, 1])
  })

  test('one repository listed by two hosts shows once, from the first host', () => {
    const rows = [row(1, { hostId: 'a' }), row(1, { hostId: 'b' }), row(2, { hostId: 'b' })]
    const kept = filterPullRequestRows(rows, DEFAULT_PULL_REQUEST_LIST_CONTROLS, viewers({}))
    expect(kept.map((r) => [r.pr.number, r.hostId])).toEqual([[2, 'b'], [1, 'a']])
    expect(pullRequestRowKey(kept[1]!)).not.toBe(pullRequestRowKey(rows[1]!))
  })

  test('a host or a project scope keeps only its rows', () => {
    const rows = [row(1, { hostId: 'a' }), row(2, { hostId: 'b', pr: { baseRepo: { host: 'github.com', owner: 'o', repo: 'x' } } }), row(3, { hostId: 'b', projectPath: '/work/site', pr: { baseRepo: { host: 'github.com', owner: 'o', repo: 'y' } } })]
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, hostId: 'b' }, viewers({})).map((r) => r.pr.number)).toEqual([3, 2])
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, hostId: 'b', projectPath: '/work/site' }, viewers({})).map((r) => r.pr.number)).toEqual([3])
  })

  test('sorts loaded rows and builds unique author and label options', () => {
    const rows = [row(1, { pr: { labels: [{ name: 'bug', color: '' }], createdAt: '2026-01-05T00:00:00Z' } }), row(2, { pr: { labels: [{ name: 'bug', color: '' }, { name: 'feature', color: '' }] } })]
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, sort: 'oldest' }, viewers({})).map((r) => r.pr.number)).toEqual([1, 2])
    expect(filterPullRequestRows(rows, { ...DEFAULT_PULL_REQUEST_LIST_CONTROLS, sort: 'created' }, viewers({})).map((r) => r.pr.number)).toEqual([1, 2])
    expect(pullRequestListFacets(rows)).toEqual({ authors: ['someone'], labels: ['bug', 'feature'] })
    expect(pullRequestLabelColor('ffab00')).toBe('#ffab00')
    expect(pullRequestLabelColor('not-a-color')).toBeNull()
  })

  test('the row review status puts changes requested before the viewer\'s own request', () => {
    expect(pullRequestRowReviewStatus({ reviewStatus: 'changes-requested', needsMyReview: true })?.accessibleLabel).toBe('Changes requested')
    expect(pullRequestRowReviewStatus({ needsMyReview: true })?.label).toBe('Your review')
    expect(pullRequestRowReviewStatus({})).toBeNull()
  })
})

describe('pull request rows across hosts', () => {
  test('rows carry each pull request\'s own checks, and none or unknown is no state', () => {
    const listing: HostPullRequests = {
      viewerLogin: null,
      projects: [{
        kind: 'page', projectPath: '/work/app', folderName: 'app', hasMore: false, page: 1, cursor: null,
        prs: [pullRequest(1, { checksState: 'failing' }), pullRequest(2, { checksState: 'none' }), pullRequest(3)],
      }],
    }
    expect(pullRequestRows([{ hostId: 'a', listing }, { hostId: 'b', listing: null }]).map((r) => [r.pr.number, r.checks])).toEqual([[1, 'failing'], [2, null], [3, null]])
  })

  test('the list state and search go to the host, and each filter keeps its own listing', async () => {
    const api = new FakeApi()
      .on('listProjects', () => [project('/work/app', 'github.com/o/r')])
      .on('prListProjects', (_ctx: unknown, roots: string[], filter: { state: string }): PrProjectListing[] =>
        [{ projectRoot: roots[0]!, page: { items: [pullRequest(filter.state === 'closed' ? 2 : 1, { checksState: 'passing' })], page: 1, hasMore: true, cursor: 'next' } }])
      .on('providerViewer', () => ({ login: 'me' }))
    const world = await hostWorld(api)
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadHosts(['inst-a'])
    directory.setListFilter({ state: 'closed', query: ' label:bug ' })
    expect(directory.hostOf('inst-a').kind).toBe('idle')
    await directory.loadHost('inst-a')
    expect(api.callsOf('prListProjects').map((call) => call[2])).toEqual([{ state: 'open' }, { state: 'closed', query: 'label:bug' }])
    const closed = shownValue(directory.hostOf('inst-a'))
    expect(closed?.projects[0]?.kind === 'page' && closed.projects[0].prs.map((pr) => pr.number)).toEqual([2])
    directory.setListFilter({ state: 'open', query: '' })
    const open = shownValue(directory.hostOf('inst-a'))
    expect(pullRequestRows([{ hostId: 'inst-a', listing: open }]).map((r) => [r.pr.number, r.checks])).toEqual([[1, 'passing']])
  })

  test('more of one project adds its next page below, without repeats', async () => {
    const api = new FakeApi()
      .on('listProjects', () => [project('/work/app', 'github.com/o/r')])
      .on('prListProjects', (): PrProjectListing[] => [{ projectRoot: '/work/app', page: { items: [pullRequest(3), pullRequest(2)], page: 1, hasMore: true, cursor: 'search:2' } }])
      .on('prList', () => ({ items: [pullRequest(2), pullRequest(1)], page: 2, hasMore: false }))
      .on('providerViewer', () => ({ login: 'me' }))
    const world = await hostWorld(api)
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadHost('inst-a')
    await directory.loadMore('inst-a', '/work/app')
    // The next page continues from the cursor the first page answered.
    expect(api.callsOf('prList')[0]!.slice(1)).toEqual([{ state: 'open' }, 2, 'search:2'])
    const listing = shownValue(directory.hostOf('inst-a'))
    const page = listing?.projects[0]
    expect(page?.kind === 'page' && [page.prs.map((pr) => pr.number), page.hasMore, page.page]).toEqual([[3, 2, 1], false, 2])
  })
})
