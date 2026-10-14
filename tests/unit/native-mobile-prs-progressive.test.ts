import { describe, expect, test } from 'bun:test'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { PrProjectListing, PrSyncChange, PullRequest } from '@solus/contracts/providers'
import { PullRequestDirectory } from '../../apps/mobile/src/features/prs/pull-request-directory'
import { memoryPullRequestCacheDatabase, PullRequestCache } from '../../apps/mobile/src/features/prs/pull-request-cache'
import { FakeApi, flushPromises } from './helpers/native-mobile-fakes'
import { deferred, detailApi, hostWorld, PR_REF, project, pullRequest } from './helpers/native-mobile-prs-fixtures'

// The phone reads pull requests over the network, where every call costs a
// round trip. These tests pin what makes the Pull Requests tab feel fast: a
// slow part never holds back the rest, the list row shows before its detail
// is read, and PR sync on the host pushes changes instead of the phone
// reading everything again on each focus.

const REPO = 'github.com/o/r'
const page = (projectRoot: string, items: PullRequest[]): PrProjectListing => ({ projectRoot, page: { items, page: 1, hasMore: false } })
const checksOf = (headSha: string, state: PrChecksSummary['state']): PrChecksSummary => ({ state, required: [], optional: [], headSha, inFlight: false })
const sync = (change: Partial<PrSyncChange>): PrSyncChange => ({ repo: REPO, pullRequests: [], missing: [], checks: [], ...change })

function listApi(api: FakeApi, prs: PullRequest[] = [pullRequest(7)]): FakeApi {
  return api
    .on('listProjects', () => [project('/work/app', REPO)])
    .on('prListProjects', () => [page('/work/app', prs)])
    .on('providerViewer', () => ({ login: 'me' }))
    .on('prChecks', () => ({ repo: { host: 'github.com', owner: 'o', repo: 'r' }, checks: [], loadFailed: false }))
    .on('prSetInterest', () => sync({}))
}

describe('pull request detail paints part by part', () => {
  test('the list row shows at once, and a slow part does not hold back the others', async () => {
    const checks = deferred<{ repo: { host: string; owner: string; repo: string }; checks: { number: number; summary: PrChecksSummary }[]; loadFailed: boolean }>()
    const overview = deferred<{ pullRequest: PullRequest; commits: []; reviewers: [] }>()
    const api = listApi(detailApi(new FakeApi()))
      .on('prGetOverview', () => overview.promise)
      .on('prChangedFiles', () => [{ path: 'a.ts', additions: 1, deletions: 0, status: 'M' }])
    const world = await hostWorld(api, { connected: true })
    const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null, cache)
    await directory.loadHost('inst-a')
    api.on('prChecks', () => checks.promise)

    const read = directory.loadDetail(PR_REF)
    await flushPromises()
    // Before the host answers: the row the list showed, with every part still unknown.
    let state = directory.detailOf(PR_REF)
    expect(state.kind === 'loading' && state.previous?.overview.pullRequest.title).toBe('PR 7')
    expect(state.kind === 'loading' && state.previous?.reading).toContain('overview')

    overview.resolve({ pullRequest: pullRequest(7, { title: 'Read' }), commits: [], reviewers: [] })
    await flushPromises()
    // The overview and files are shown; the checks are still unknown, not "none".
    state = directory.detailOf(PR_REF)
    expect(state.kind).toBe('loading')
    if (state.kind !== 'loading') return
    expect(state.previous?.overview.pullRequest.title).toBe('Read')
    expect(state.previous?.files).toHaveLength(1)
    expect(state.previous?.reading).toEqual(['checks'])

    checks.resolve({ repo: { host: 'github.com', owner: 'o', repo: 'r' }, checks: [{ number: 7, summary: checksOf('head-7', 'passing') }], loadFailed: false })
    await read
    const loaded = directory.detailOf(PR_REF)
    expect(loaded.kind === 'loaded' && loaded.value.checks?.state).toBe('passing')
    expect(loaded.kind === 'loaded' && loaded.value.reading).toBeUndefined()
    // Only the whole answer is kept on the device.
    const copy = await cache.read<{ reading?: string[] }>('inst-a', `detail:${PR_REF.projectPath}:${PR_REF.number}`)
    expect(copy?.reading).toBeUndefined()
  })

  test('a failed overview still fails the read; a part that answers late does not hide the error', async () => {
    const comments = deferred<[]>()
    const api = detailApi(new FakeApi())
      .on('prGetOverview', () => { throw new Error('not found') })
      .on('prListComments', () => comments.promise)
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadDetail(PR_REF)
    comments.resolve([])
    await flushPromises()
    const state = directory.detailOf(PR_REF)
    expect(state.kind === 'error' && state.message).toBe('not found')
  })
})

describe('pull request list paints before its checks', () => {
  test('rows show while their checks are read, and the checks follow', async () => {
    const checks = deferred<{ repo: { host: string; owner: string; repo: string }; checks: { number: number; summary: PrChecksSummary }[]; loadFailed: boolean }>()
    const api = listApi(new FakeApi()).on('prChecks', () => checks.promise)
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    const read = directory.loadHost('inst-a')
    await flushPromises()
    const shown = directory.hostOf('inst-a')
    expect(shown.kind).toBe('loading')
    const rows = shown.kind === 'loading' ? shown.previous?.projects[0] : undefined
    expect(rows?.kind === 'page' && rows.prs.map((pr) => pr.number)).toEqual([7])

    checks.resolve({ repo: { host: 'github.com', owner: 'o', repo: 'r' }, checks: [{ number: 7, summary: checksOf('head-7', 'failing') }], loadFailed: false })
    await read
    const loaded = directory.hostOf('inst-a')
    const project = loaded.kind === 'loaded' ? loaded.value.projects[0] : undefined
    expect(project?.kind === 'page' && project.checks.map((entry) => entry.state)).toEqual(['failing'])
  })

  test('a list read again starts with the projects it showed, and reads once when they are the same', async () => {
    const api = listApi(new FakeApi())
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadHost('inst-a')
    await directory.loadHost('inst-a')
    expect(api.callsOf('prListProjects')).toHaveLength(2)

    // A project added on the host is read with the others.
    api.on('listProjects', () => [project('/work/app', REPO), project('/work/site', 'github.com/o/site')])
    await directory.loadHost('inst-a')
    expect(api.callsOf('prListProjects').at(-1)![1]).toEqual(['/work/app', '/work/site'])
  })
})

describe('pull requests kept fresh by PR sync', () => {
  test('the screens of one project send one interest set, and the last release clears it', async () => {
    const api = listApi(new FakeApi())
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    const releaseList = directory.want('inst-a', '/work/app', [{ kind: 'repository' }])
    const releaseDetail = directory.want('inst-a', '/work/app', [{ kind: 'review', number: 7 }])
    await flushPromises()
    expect(api.callsOf('prSetInterest')).toEqual([[expect.anything(), [{ kind: 'repository' }, { kind: 'review', number: 7 }]]])
    releaseDetail()
    releaseList()
    await flushPromises()
    expect(api.callsOf('prSetInterest').at(-1)![1]).toEqual([])
  })

  test('a pushed change updates the list row and the open detail without a read', async () => {
    const api = listApi(detailApi(new FakeApi()))
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadHost('inst-a')
    await directory.loadDetail(PR_REF)
    directory.want('inst-a', '/work/app', [{ kind: 'review', number: 7 }])
    await flushPromises()
    const reads = api.calls.length

    world.transports[0]!.emit('pr.changed', sync({
      pullRequests: [pullRequest(7, { title: 'Renamed', updatedAt: '2026-02-01T00:00:00Z' }), pullRequest(9, { state: 'open' })],
      checks: [{ number: 7, summary: checksOf('head-7', 'failing') }],
    }))
    expect(api.calls.length).toBe(reads)
    const list = directory.hostOf('inst-a')
    const rows = list.kind === 'loaded' ? list.value.projects[0] : undefined
    // A new open pull request joins the open list; the changed one is replaced.
    expect(rows?.kind === 'page' && rows.prs.map((pr) => `${pr.number} ${pr.title}`)).toEqual(['9 PR 9', '7 Renamed'])
    expect(rows?.kind === 'page' && rows.checks.find((entry) => entry.number === 7)?.state).toBe('failing')
    const detail = directory.detailOf(PR_REF)
    expect(detail.kind === 'loaded' && detail.value.overview.pullRequest.title).toBe('Renamed')
    expect(detail.kind === 'loaded' && detail.value.checks?.state).toBe('failing')

    // An older copy of the pull request does not replace a newer one.
    world.transports[0]!.emit('pr.changed', sync({ pullRequests: [pullRequest(7, { title: 'Old' })] }))
    const after = directory.detailOf(PR_REF)
    expect(after.kind === 'loaded' && after.value.overview.pullRequest.title).toBe('Renamed')
  })

  test('a host connection accepted again is told the interest again', async () => {
    const api = listApi(new FakeApi())
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    directory.want('inst-a', '/work/app', [{ kind: 'repository' }])
    await flushPromises()
    expect(api.callsOf('prSetInterest')).toHaveLength(1)
    await world.transports[0]!.accept(true)
    await flushPromises()
    expect(api.callsOf('prSetInterest')).toHaveLength(2)
  })

  test('a focus within the fresh time does not read again; a refresh always does', async () => {
    const api = detailApi(new FakeApi())
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadDetail(PR_REF)
    await directory.loadDetail(PR_REF, { freshFor: 30_000 })
    expect(api.callsOf('prGetOverview')).toHaveLength(1)
    await directory.loadDetail(PR_REF)
    expect(api.callsOf('prGetOverview')).toHaveLength(2)
  })
})
