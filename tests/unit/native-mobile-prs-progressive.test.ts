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
/** A summary with one failing check, as PR sync pushes it. */
const failingChecks = (headSha: string): PrChecksSummary => ({
  ...checksOf(headSha, 'failing'),
  required: [{ id: 'ci', name: 'ci', conclusion: 'failure', inFlight: false, detailsUrl: null, appName: null, startedAt: null, completedAt: null }],
})
const sync = (change: Partial<PrSyncChange>): PrSyncChange => ({ repo: REPO, pullRequests: [], missing: [], checks: [], ...change })

function listApi(api: FakeApi, prs: PullRequest[] = [pullRequest(7)]): FakeApi {
  return api
    .on('listProjects', () => [project('/work/app', REPO)])
    .on('prListProjects', () => [page('/work/app', prs)])
    .on('providerViewer', () => ({ login: 'me' }))
    .on('prSetInterest', () => sync({}))
}

describe('pull request detail paints part by part', () => {
  test('the list row shows at once, and a slow part does not hold back the others', async () => {
    const files = deferred<{ path: string; additions: number; deletions: number; status: string }[]>()
    const overview = deferred<{ pullRequest: PullRequest; commits: []; reviewers: [] }>()
    const api = listApi(detailApi(new FakeApi()))
    const world = await hostWorld(api, { connected: true })
    const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null, cache)
    await directory.loadHost('inst-a')
    api.on('prGetOverview', () => overview.promise).on('prChangedFiles', () => files.promise)

    const read = directory.loadDetail(PR_REF)
    await flushPromises()
    // Before the host answers: the row the list showed, with every part still unknown.
    let state = directory.detailOf(PR_REF)
    expect(state.kind === 'loading' && state.previous?.overview.pullRequest.title).toBe('PR 7')
    expect(state.kind === 'loading' && state.previous?.reading).toContain('overview')

    overview.resolve({ pullRequest: pullRequest(7, { title: 'Read' }), commits: [], reviewers: [] })
    await flushPromises()
    // The overview is shown; the files are still unknown, not "none".
    state = directory.detailOf(PR_REF)
    expect(state.kind).toBe('loading')
    if (state.kind !== 'loading') return
    expect(state.previous?.overview.pullRequest.title).toBe('Read')
    expect(state.previous?.reading).toEqual(['files', 'checks'])

    files.resolve([{ path: 'a.ts', additions: 1, deletions: 0, status: 'M' }])
    await read
    const loaded = directory.detailOf(PR_REF)
    expect(loaded.kind === 'loaded' && loaded.value.files).toHaveLength(1)
    // Only PR sync answers the checks, so they are still being read.
    expect(loaded.kind === 'loaded' && loaded.value.reading).toEqual(['checks'])
  })

  test('the checks come from the review interest, not from a read of their own', async () => {
    // WHY: the detail screen holds a review interest, and PR sync reads the
    // checks for it. A `prChecks` read beside it asked the host the same
    // question twice on every opening.
    const api = listApi(detailApi(new FakeApi()))
      .on('prSetInterest', () => sync({ checks: [{ number: 7, summary: checksOf('head-7', 'passing') }] }))
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadHost('inst-a')

    await directory.loadDetail(PR_REF)
    let state = directory.detailOf(PR_REF)
    expect(state.kind === 'loaded' && state.value.reading).toEqual(['checks'])
    directory.want('inst-a', '/work/app', [{ kind: 'review', number: 7 }])
    await flushPromises()

    state = directory.detailOf(PR_REF)
    expect(state.kind === 'loaded' && state.value.checks?.state).toBe('passing')
    expect(state.kind === 'loaded' && state.value.reading).toBeUndefined()
    expect(api.callsOf('prChecks')).toHaveLength(0)
  })

  test('checks the interest answered before the detail had anything to show still reach it', async () => {
    const overview = deferred<{ pullRequest: PullRequest; commits: []; reviewers: [] }>()
    const api = detailApi(new FakeApi())
      .on('prGetOverview', () => overview.promise)
      .on('prSetInterest', () => sync({ checks: [{ number: 7, summary: checksOf('head-7', 'failing') }] }))
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)

    const read = directory.loadDetail(PR_REF)
    directory.want('inst-a', '/work/app', [{ kind: 'review', number: 7 }])
    await flushPromises()
    overview.resolve({ pullRequest: pullRequest(7), commits: [], reviewers: [] })
    await read

    const state = directory.detailOf(PR_REF)
    expect(state.kind === 'loaded' && state.value.checks?.state).toBe('failing')
    expect(state.kind === 'loaded' && state.value.reading).toBeUndefined()
  })

  test('a refused interest names the checks missing', async () => {
    const api = detailApi(new FakeApi()).on('prSetInterest', () => { throw new Error('rate limited') })
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadDetail(PR_REF)
    directory.want('inst-a', '/work/app', [{ kind: 'review', number: 7 }])
    await flushPromises()

    const state = directory.detailOf(PR_REF)
    expect(state.kind === 'loaded' && state.value.missing).toEqual(['checks'])
    expect(state.kind === 'loaded' && state.value.reading).toBeUndefined()
  })

  test('screens that read one pull request together share one read; a refresh reads anew', async () => {
    // WHY: the detail, files, and ask screens of a pull request are stacked,
    // and each reads it when the host connects again.
    const overview = deferred<{ pullRequest: PullRequest; commits: []; reviewers: [] }>()
    const api = detailApi(new FakeApi()).on('prGetOverview', () => overview.promise)
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)

    const reads = [directory.loadDetail(PR_REF), directory.loadDetail(PR_REF), directory.loadDetail(PR_REF)]
    await flushPromises()
    expect(api.callsOf('prGetOverview')).toHaveLength(1)

    const refresh = directory.loadDetail(PR_REF, { force: true })
    await flushPromises()
    expect(api.callsOf('prGetOverview')).toHaveLength(2)
    overview.resolve({ pullRequest: pullRequest(7), commits: [], reviewers: [] })
    await Promise.all([...reads, refresh])
    expect(directory.detailOf(PR_REF).kind).toBe('loaded')
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

describe('pull request list paints in one read', () => {
  test('rows carry their own checks, so the list asks for no checks', async () => {
    // WHY: a checks read per project after the list cost one more round trip
    // per project. The host's list rows say each head's check state.
    const api = listApi(new FakeApi(), [pullRequest(7, { checksState: 'failing' })])
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadHost('inst-a')

    const loaded = directory.hostOf('inst-a')
    const project = loaded.kind === 'loaded' ? loaded.value.projects[0] : undefined
    expect(project?.kind === 'page' && project.prs.map((pr) => pr.checksState)).toEqual(['failing'])
    expect(api.callsOf('prChecks')).toHaveLength(0)
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
    const releaseRow = directory.want('inst-a', '/work/app', [{ kind: 'pull-request', number: 7 }])
    const releaseDetail = directory.want('inst-a', '/work/app', [{ kind: 'review', number: 7 }])
    await flushPromises()
    expect(api.callsOf('prSetInterest')).toEqual([[expect.anything(), [{ kind: 'pull-request', number: 7 }, { kind: 'review', number: 7 }]]])
    releaseDetail()
    releaseRow()
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
      checks: [{ number: 7, summary: failingChecks('head-7') }],
    }))
    expect(api.calls.length).toBe(reads)
    const list = directory.hostOf('inst-a')
    const rows = list.kind === 'loaded' ? list.value.projects[0] : undefined
    // A new open pull request joins the open list; the changed one is replaced.
    expect(rows?.kind === 'page' && rows.prs.map((pr) => `${pr.number} ${pr.title}`)).toEqual(['9 PR 9', '7 Renamed'])
    expect(rows?.kind === 'page' && rows.prs.find((pr) => pr.number === 7)?.checksState).toBe('failing')
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
    directory.want('inst-a', '/work/app', [{ kind: 'review', number: 7 }])
    await flushPromises()
    expect(api.callsOf('prSetInterest')).toHaveLength(1)
    await world.transports[0]!.accept(true)
    await flushPromises()
    expect(api.callsOf('prSetInterest')).toHaveLength(2)
  })

  test('a list on screen reads again when the host says its repository changed; a list off screen reads at the next focus', async () => {
    // WHY: PR sync does not poll the repository for new pull requests. An
    // agent turn that ends there may have opened one, and the host says so.
    const api = listApi(new FakeApi())
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadHost('inst-a')
    const releaseList = directory.showList()

    world.transports[0]!.emit('pr.changed', sync({ repo: 'github.com/o/other', listChanged: true }))
    await flushPromises()
    expect(api.callsOf('prListProjects')).toHaveLength(1)

    api.on('prListProjects', () => [page('/work/app', [pullRequest(8), pullRequest(7)])])
    world.transports[0]!.emit('pr.changed', sync({ listChanged: true }))
    await flushPromises()
    expect(api.callsOf('prListProjects')).toHaveLength(2)
    const list = directory.hostOf('inst-a')
    const rows = list.kind === 'loaded' ? list.value.projects[0] : undefined
    expect(rows?.kind === 'page' && rows.prs.map((pr) => pr.number)).toEqual([8, 7])

    releaseList()
    world.transports[0]!.emit('pr.changed', sync({ listChanged: true }))
    await flushPromises()
    expect(api.callsOf('prListProjects')).toHaveLength(2)
    await directory.loadHost('inst-a', { freshFor: 30_000 })
    expect(api.callsOf('prListProjects')).toHaveLength(3)
  })

  test('a changed repository reads again only its own projects', async () => {
    // WHY: an agent turn ends often. Reading every project of the host, its
    // project list, and its account again for one repository spent a read of
    // each project on every turn.
    const api = listApi(new FakeApi())
      .on('listProjects', () => [project('/work/app', REPO), project('/work/site', 'github.com/o/site')])
      .on('prListProjects', (_ctx: unknown, roots: string[]) => roots.map((root) => page(root, [pullRequest(root === '/work/app' ? 7 : 1)])))
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
    await directory.loadHost('inst-a')
    directory.showList()
    const projectReads = api.callsOf('listProjects').length
    const viewerReads = api.callsOf('providerViewer').length

    api.on('prListProjects', (_ctx: unknown, roots: string[]) => roots.map((root) => page(root, [pullRequest(8), pullRequest(7)])))
    world.transports[0]!.emit('pr.changed', sync({ listChanged: true }))
    await flushPromises()

    expect(api.callsOf('prListProjects').at(-1)![1]).toEqual(['/work/app'])
    expect(api.callsOf('listProjects')).toHaveLength(projectReads)
    expect(api.callsOf('providerViewer')).toHaveLength(viewerReads)
    const list = directory.hostOf('inst-a')
    const projects = list.kind === 'loaded' ? list.value.projects : []
    expect(projects.map((entry) => entry.kind === 'page' ? [entry.projectPath, entry.prs.map((pr) => pr.number)] : null)).toEqual([
      ['/work/app', [8, 7]],
      ['/work/site', [1]],
    ])
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
