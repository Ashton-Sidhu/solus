import { describe, expect, test } from 'bun:test'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { PrProjectListing, PrSyncChange, PullRequest } from '@solus/contracts/providers'
import { keepEqual } from '@solus/client-core/keep-equal'
import { pullRequestRows } from '../../apps/mobile/src/features/prs/lib/pull-request-list'
import { retainDetail, retainListing } from '../../apps/mobile/src/features/prs/lib/pull-request-retain'
import { memoryPullRequestCacheDatabase, PullRequestCache } from '../../apps/mobile/src/features/prs/pull-request-cache'
import { PullRequestDirectory, type HostPullRequests } from '../../apps/mobile/src/features/prs/pull-request-directory'
import { PullRequestListSelection } from '../../apps/mobile/src/features/prs/pull-request-list-selection'
import { HostReads, shownValue, type LoadState } from '../../apps/mobile/src/features/prs/pull-request-reads'
import { Listeners } from '../../apps/mobile/src/lib/listeners'
import { FakeApi, flushPromises } from './helpers/native-mobile-fakes'
import { detailApi, hostWorld, PR_REF, project, pullRequest } from './helpers/native-mobile-prs-fixtures'

// The Pull Requests tab and the pull request screen select values from one
// directory that every read and PR sync push notifies. A read that answers
// what shows already must keep the shown objects, so a value-only selector
// and a memoized row see no change; the read state (loading, loaded, error)
// still changes, so spinners, notices, and offline lines stay true.

const REPO = 'github.com/o/r'
const page = (projectRoot: string, items: PullRequest[]): PrProjectListing => ({ projectRoot, page: { items, page: 1, hasMore: false } })
const sync = (change: Partial<PrSyncChange>): PrSyncChange => ({ repo: REPO, pullRequests: [], missing: [], checks: [], ...change })
const checksOf = (headSha: string, state: PrChecksSummary['state']): PrChecksSummary => ({ state, required: [], optional: [], headSha, inFlight: false })

/** A host that lists `prs()` for one project; each read sends new objects. */
async function listWorld(prs: () => PullRequest[] = () => [pullRequest(7), pullRequest(8)]) {
  const answer = { prs }
  const api = detailApi(new FakeApi())
    .on('listProjects', () => [project('/work/app', REPO)])
    .on('prListProjects', () => [page('/work/app', answer.prs())])
    .on('providerViewer', () => ({ login: 'me' }))
    .on('prSetInterest', () => sync({}))
  const world = await hostWorld(api, { connected: true })
  const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
  const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null, cache)
  return { api, world, directory, answer, cache }
}

function prsOf(state: LoadState<HostPullRequests>): readonly PullRequest[] {
  const project = shownValue(state)?.projects[0]
  return project?.kind === 'page' ? project.prs : []
}

describe('PR reads keep equal answers', () => {
  test('an equal refetch changes the state twice and the shown value never', async () => {
    const world = await hostWorld(new FakeApi(), { connected: true })
    const changes = new Listeners()
    const reads = new HostReads(changes, (id) => world.connections.connection(id), new PullRequestCache(memoryPullRequestCacheDatabase()))
    const map = new Map<string, LoadState<{ title: string; labels: string[] }>>()
    const run = async (_connection: unknown, _previous: unknown, show: (partial: { title: string; labels: string[] }) => void) => {
      // A part equal to what shows is not shown again.
      show({ title: 'Fixture PR', labels: ['test'] })
      return { title: 'Fixture PR', labels: ['test'] }
    }
    await reads.read(map, 'inst-a\0detail', 'inst-a', 'detail', run, { retain: keepEqual })
    const before = shownValue(map.get('inst-a\0detail')!)
    const kinds: string[] = []
    const stop = changes.subscribe(() => kinds.push(map.get('inst-a\0detail')!.kind))
    await reads.read(map, 'inst-a\0detail', 'inst-a', 'detail', run, { retain: keepEqual })
    expect(kinds).toEqual(['loading', 'loaded'])
    expect(shownValue(map.get('inst-a\0detail')!)).toBe(before)
    stop()
    world.connections.dispose('inst-a')
  })

  test('an equal list refresh notifies twice, keeps the listing and every pull request, and keeps the rows', async () => {
    const { world, directory } = await listWorld()
    await directory.loadHost('inst-a')
    const selection = new PullRequestListSelection(directory)
    const listing = shownValue(directory.hostOf('inst-a'))
    const hosts = selection.hosts(['inst-a'])
    const rows = selection.rows(['inst-a'])
    let notifications = 0
    const hostSnapshots = new Set<unknown>()
    const rowSnapshots = new Set<unknown>()
    const stop = directory.changes.subscribe(() => {
      notifications += 1
      hostSnapshots.add(selection.hosts(['inst-a']))
      rowSnapshots.add(selection.rows(['inst-a']))
    })
    await directory.loadHost('inst-a')
    // Before: three notifications (loading, the projects shown, loaded) and new objects for equal pull requests.
    expect(notifications).toBe(2)
    expect(shownValue(directory.hostOf('inst-a'))).toBe(listing)
    // The read state still changed, so the notices and spinners see it.
    expect(hostSnapshots.size).toBe(2)
    expect(selection.hosts(['inst-a'])).not.toBe(hosts)
    expect([...rowSnapshots]).toEqual([rows])
    expect(selection.rows(['inst-a'])).toBe(rows)
    stop()
    world.connections.dispose('inst-a')
  })

  test('a changed pull request is a new row; the others keep their rows, even when it moves up the page', async () => {
    const { world, directory, answer } = await listWorld()
    await directory.loadHost('inst-a')
    const selection = new PullRequestListSelection(directory)
    const [seven, eight] = selection.rows(['inst-a'])
    answer.prs = () => [pullRequest(8, { title: 'Renamed', updatedAt: '2026-03-01T00:00:00Z' }), pullRequest(7)]
    await directory.loadHost('inst-a')
    const rows = selection.rows(['inst-a'])
    expect(rows.map((row) => `${row.pr.number} ${row.pr.title}`)).toEqual(['8 Renamed', '7 PR 7'])
    expect(rows[1]).toBe(seven!)
    expect(rows[0]).not.toBe(eight!)
    world.connections.dispose('inst-a')
  })

  test('changed permissions and checks reach the row and the detail', async () => {
    const { world, directory, answer } = await listWorld()
    await directory.loadHost('inst-a')
    await directory.loadDetail(PR_REF)
    const detail = shownValue(directory.detailOf(PR_REF))!
    const listed = prsOf(directory.hostOf('inst-a'))[0]!
    const viewerPermissions = { ...pullRequest(7).viewerPermissions, comment: false }
    answer.prs = () => [pullRequest(7, { viewerPermissions, checksState: 'failing' }), pullRequest(8)]
    await directory.loadHost('inst-a')
    const changed = prsOf(directory.hostOf('inst-a'))[0]!
    expect(changed).not.toBe(listed)
    expect(changed.viewerPermissions.comment).toBe(false)
    expect(changed.checksState).toBe('failing')
    expect(new PullRequestListSelection(directory).rows(['inst-a'])[0]!.checks).toBe('failing')

    // PR sync pushes new checks: the detail changes; the same checks again change nothing.
    directory.want('inst-a', '/work/app', [{ kind: 'review', number: 7 }])
    await flushPromises()
    world.transports[0]!.emit('pr.changed', sync({ checks: [{ number: 7, summary: checksOf('head-7', 'passing') }] }))
    const withChecks = shownValue(directory.detailOf(PR_REF))!
    expect(withChecks).not.toBe(detail)
    expect(withChecks.checks?.state).toBe('passing')
    expect(withChecks.comments).toBe(detail.comments)
    let notifications = 0
    const stop = directory.changes.subscribe(() => { notifications += 1 })
    const row = prsOf(directory.hostOf('inst-a'))[0]!
    world.transports[0]!.emit('pr.changed', sync({ checks: [{ number: 7, summary: checksOf('head-7', 'passing') }] }))
    expect(notifications).toBe(0)
    expect(prsOf(directory.hostOf('inst-a'))[0]).toBe(row)
    expect(shownValue(directory.detailOf(PR_REF))).toBe(withChecks)
    stop()
    world.connections.dispose('inst-a')
  })

  test('a forced detail refresh still reads every part; an equal answer keeps the detail, a changed part is new and the rest is kept', async () => {
    const { api, world, directory } = await listWorld()
    await directory.loadDetail(PR_REF)
    const before = shownValue(directory.detailOf(PR_REF))!
    const calls = api.callsOf('prGetOverview').length
    await directory.loadDetail(PR_REF, { force: true })
    expect(api.callsOf('prGetOverview').length).toBe(calls + 1)
    expect(directory.detailOf(PR_REF).kind).toBe('loaded')
    expect(shownValue(directory.detailOf(PR_REF))).toBe(before)

    api.on('prChangedFiles', () => [{ path: 'a.ts', additions: 1, deletions: 0, status: 'M' }])
    await directory.loadDetail(PR_REF, { force: true })
    const after = shownValue(directory.detailOf(PR_REF))!
    expect(after).not.toBe(before)
    expect(after.files).toHaveLength(1)
    expect(after.overview).toBe(before.overview)
    world.connections.dispose('inst-a')
  })

  test('a failed refresh shows the error with the same listing; offline, the device copy shows', async () => {
    const { api, world, directory, cache } = await listWorld()
    await directory.loadHost('inst-a')
    const listing = shownValue(directory.hostOf('inst-a'))
    api.on('listProjects', () => { throw new Error('host is busy') })
    await directory.loadHost('inst-a')
    const failed = directory.hostOf('inst-a')
    expect(failed.kind === 'error' && failed.message).toBe('host is busy')
    expect(shownValue(failed)).toBe(listing)

    // A new directory on the same device: the host is gone, the saved copy shows.
    await flushPromises()
    const offline = new PullRequestDirectory(() => null, () => null, cache)
    await offline.loadHost('inst-a')
    const state = offline.hostOf('inst-a')
    expect(state.kind === 'error' && state.offline).toBe(true)
    expect(prsOf(state).map((pr) => pr.number)).toEqual([7, 8])
    world.connections.dispose('inst-a')
  })
})

describe('retainListing and pullRequestRows', () => {
  const listing = (prs: PullRequest[], viewerLogin: string | null = 'me'): HostPullRequests => ({
    projects: [{ kind: 'page', projectPath: '/work/app', folderName: 'app', prs, hasMore: false, page: 1, cursor: null }],
    viewerLogin,
  })

  test('a new account, page, or project is a change; equal parts keep their objects', () => {
    const shown = listing([pullRequest(7)])
    expect(retainListing(listing([pullRequest(7)]), shown)).toBe(shown)
    const other = retainListing(listing([pullRequest(7)], 'someone'), shown)
    expect(other).not.toBe(shown)
    expect(other.projects).toBe(shown.projects)
    const more = retainListing({ ...listing([pullRequest(7)]), projects: [{ ...listing([pullRequest(7)]).projects[0]!, hasMore: true } as HostPullRequests['projects'][number]] }, shown)
    expect(more.projects[0]).not.toBe(shown.projects[0])
  })

  test('a detail keeps each equal part; a part named missing is a change', () => {
    const detail = (missing: ('comments' | 'files')[] = []) => ({
      overview: { pullRequest: pullRequest(7), commits: [], reviewers: [] }, comments: [], threads: [], files: [], checks: null, stack: null, missing,
    })
    const shown = detail()
    expect(retainDetail(detail(), shown)).toBe(shown)
    const failed = retainDetail(detail(['files']), shown)
    expect(failed).not.toBe(shown)
    expect(failed.missing).toEqual(['files'])
    expect(failed.overview).toBe(shown.overview)
    expect(failed.files).toBe(shown.files)
  })

  test('a row is kept only for the same pull request object in the same project', () => {
    const shown = listing([pullRequest(7)])
    const rows = pullRequestRows([{ hostId: 'h', listing: shown }])
    expect(pullRequestRows([{ hostId: 'h', listing: shown }], rows)[0]).toBe(rows[0]!)
    const renamed = { ...shown, projects: [{ ...shown.projects[0]!, folderName: 'App' } as HostPullRequests['projects'][number]] }
    expect(pullRequestRows([{ hostId: 'h', listing: renamed }], rows)[0]).not.toBe(rows[0]!)
  })
})

describe('the list selection reads rows only when a shown listing changes', () => {
  /** A listing that counts each walk of its projects, as `pullRequestRows` makes. */
  function countedListing(prs: PullRequest[], walks: { count: number }): HostPullRequests {
    const projects: HostPullRequests['projects'] = [{ kind: 'page', projectPath: '/work/app', folderName: 'app', prs, hasMore: false, page: 1, cursor: null }]
    return { viewerLogin: 'me', get projects() { walks.count += 1; return projects } }
  }

  function fakeDirectory() {
    const states = new Map<string, LoadState<HostPullRequests>>()
    return { states, hostOf: (hostId: string): LoadState<HostPullRequests> => states.get(hostId) ?? { kind: 'idle' } }
  }

  test('loading, loaded, and an error that keep each listing walk no pull request and keep the rows; the host states still change', () => {
    const walks = { count: 0 }
    const listing = countedListing([pullRequest(7), pullRequest(8)], walks)
    const directory = fakeDirectory()
    directory.states.set('a', { kind: 'loaded', value: listing })
    const selection = new PullRequestListSelection(directory)
    const rows = selection.rows(['a'])
    expect(rows).toHaveLength(2)
    expect(walks.count).toBe(1)
    const hosts = selection.hosts(['a'])
    for (const state of [
      { kind: 'loading', previous: listing },
      { kind: 'loaded', value: listing },
      { kind: 'error', message: 'busy', githubAuth: false, offline: false, previous: listing },
    ] satisfies LoadState<HostPullRequests>[]) {
      directory.states.set('a', state)
      expect(selection.rows(['a'])).toBe(rows)
    }
    expect(walks.count).toBe(1)
    expect(selection.hosts(['a'])).not.toBe(hosts)
    expect(selection.hosts(['a'])[0]!.state.kind).toBe('error')
  })

  test('a changed listing, a new host order, and a removed host build the rows again, keeping unchanged rows', () => {
    const walks = { count: 0 }
    const directory = fakeDirectory()
    const first = countedListing([pullRequest(7)], walks)
    const second = countedListing([pullRequest(9)], walks)
    directory.states.set('a', { kind: 'loaded', value: first })
    directory.states.set('b', { kind: 'loaded', value: second })
    const selection = new PullRequestListSelection(directory)
    const rows = selection.rows(['a', 'b'])
    expect(rows.map((row) => `${row.hostId}#${row.pr.number}`)).toEqual(['a#7', 'b#9'])

    const reordered = selection.rows(['b', 'a'])
    expect(reordered.map((row) => `${row.hostId}#${row.pr.number}`)).toEqual(['b#9', 'a#7'])
    expect(reordered[0]).toBe(rows[1]!)

    const removed = selection.rows(['b'])
    expect(removed.map((row) => row.hostId)).toEqual(['b'])

    const changed = countedListing([pullRequest(9), pullRequest(10)], walks)
    directory.states.set('b', { kind: 'loading', previous: changed })
    const grown = selection.rows(['b'])
    expect(grown.map((row) => row.pr.number)).toEqual([9, 10])
    expect(grown).not.toBe(removed)
    const before = walks.count
    directory.states.set('b', { kind: 'loaded', value: changed })
    expect(selection.rows(['b'])).toBe(grown)
    expect(walks.count).toBe(before)
  })
})
