import { describe, expect, test } from 'bun:test'
import type { PrProjectListing, PullRequest } from '@solus/contracts/providers'
import type { ProjectEntry } from '@solus/contracts/types'
import { PullRequestDirectory, notificationRepositoryKey } from '../../apps/mobile/src/features/prs/pull-request-directory'
import { canGiveVerdict, prStateTone } from '../../apps/mobile/src/features/prs/lib/pr-presentation'
import { nativeDestination } from '../../apps/mobile/src/features/notifications/lib/native-destinations'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'

// plan 017 stage 5: the phone reads pull requests through the host, which owns
// the GitHub credential and finds each repository from a project folder. These
// tests pin what the person relies on: one unreadable project never hides the
// others, a host without GitHub asks to be connected rather than retried, and
// a review lands on the head the person was shown.

const project = (path: string, repositoryKey: string | null): ProjectEntry => ({
  key: path, path, folderName: path.split('/').pop()!, addedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z', repositoryKey,
})

const pullRequest = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  number, url: `https://github.com/o/r/pull/${number}`, title: `PR ${number}`, headSha: `head-${number}`, baseSha: 'base',
  baseRepo: { host: 'github.com', owner: 'o', repo: 'r' }, headRepo: { owner: 'o', repo: 'r', isFork: false },
  author: 'someone', authorAvatarUrl: '', state: 'open', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  draft: false, labels: [], additions: 1, deletions: 1, body: '', baseRef: 'main', headRef: 'feature', changedFiles: 1,
  mergeable: null, mergeStateStatus: null,
  capabilities: { diff: true, diffFileContents: true, inlineComments: true, threadReplies: true, threadResolution: true, reviewVerdicts: ['comment', 'approve', 'request-changes'], actions: [], mergeMethods: [], reviewerRequests: false, reviewerCandidates: false, labelManagement: false },
  viewerPermissions: { actions: [], reviewVerdicts: ['comment', 'approve', 'request-changes'], comment: true, resolveThreads: false, requestReviewers: false, manageLabels: false },
  ...overrides,
})

const page = (projectRoot: string, items: PullRequest[]): PrProjectListing => ({ projectRoot, page: { items, page: 1, hasMore: false } })

async function setup(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
  const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null)
  return { world, directory }
}

describe('native pull request directory', () => {
  test('reads only projects with a remote, in one host call, and keeps an unreadable project apart', async () => {
    const api = new FakeApi()
      .on('listProjects', () => [project('/work/app', 'github.com/o/r'), project('/work/notes', null), project('/work/site', 'github.com/o/site')])
      .on('prListProjects', () => [page('/work/app', [pullRequest(1)]), { projectRoot: '/work/site', unavailable: 'no-remote' }])
      .on('providerViewer', () => ({ login: 'me' }))
    const { directory } = await setup(api)
    await directory.loadHost('inst-a')
    const state = directory.hostOf('inst-a')
    expect(state.kind).toBe('loaded')
    expect(api.callsOf('prListProjects')).toHaveLength(1)
    expect(api.callsOf('prListProjects')[0]![1]).toEqual(['/work/app', '/work/site'])
    if (state.kind !== 'loaded') return
    expect(state.value.projects.map((entry) => entry.kind)).toEqual(['page', 'unavailable'])
    expect(state.value.viewerLogin).toBe('me')
  })

  test('a host whose every project refuses for want of GitHub asks to connect it', async () => {
    const api = new FakeApi()
      .on('listProjects', () => [project('/work/app', 'github.com/o/r')])
      .on('prListProjects', () => [{ projectRoot: '/work/app', error: 'GitHub is not connected on this host.' }])
      .on('providerViewer', () => { throw new Error('GitHub is not connected') })
    const { directory } = await setup(api)
    await directory.loadHost('inst-a')
    const state = directory.hostOf('inst-a')
    expect(state.kind === 'error' && state.githubAuth).toBe(true)
  })

  test('a detail shows the pull request when its checks cannot be read, and names what is missing', async () => {
    const api = new FakeApi()
      .on('prGetOverview', () => ({ pullRequest: pullRequest(7), commits: [], reviewers: [] }))
      .on('prListComments', () => [])
      .on('prListThreads', () => [])
      .on('prChangedFiles', () => [{ path: 'a.ts', additions: 1, deletions: 0, status: 'M' }])
      .on('prChecks', () => { throw new Error('rate limited') })
    const { directory } = await setup(api)
    const ref = { hostId: 'inst-a', projectPath: '/work/app', number: 7 }
    await directory.loadDetail(ref)
    const state = directory.detailOf(ref)
    expect(state.kind).toBe('loaded')
    if (state.kind !== 'loaded') return
    expect(state.value.missing).toEqual(['checks'])
    expect(state.value.files).toHaveLength(1)
  })

  test('a detail carries its GitHub stack, and a failed stack read only hides the stack', async () => {
    // WHY: the phone steps between stack layers from this answer; the stack is
    // a preview on GitHub, so its failure must not fail the pull request.
    const stack = {
      number: 4, url: 'https://github.com/o/r/stacks/4', base: 'main',
      layers: [{ number: 6, title: 'Base', headRef: 'one', state: 'merged' as const, draft: false }, { number: 7, title: 'PR 7', headRef: 'two', state: 'open' as const, draft: false }],
    }
    let stackRead: () => typeof stack = () => stack
    const api = new FakeApi()
      .on('prGetOverview', () => ({ pullRequest: pullRequest(7), commits: [], reviewers: [] }))
      .on('prListComments', () => [])
      .on('prListThreads', () => [])
      .on('prChangedFiles', () => [])
      .on('prChecks', () => ({ checks: [] }))
      .on('prGetStack', () => stackRead())
    const { directory } = await setup(api)
    const ref = { hostId: 'inst-a', projectPath: '/work/app', number: 7 }
    await directory.loadDetail(ref)
    const read = directory.detailOf(ref)
    expect(read.kind === 'loaded' && read.value.stack).toEqual(stack)

    stackRead = () => { throw new Error('rate limited') }
    await directory.loadDetail(ref)
    const failed = directory.detailOf(ref)
    expect(failed.kind).toBe('loaded')
    expect(failed.kind === 'loaded' && failed.value.stack).toBeNull()
    expect(failed.kind === 'loaded' && failed.value.missing).toEqual([])
  })

  test('a notification finds its pull request on a connected host by repository, not by path', async () => {
    const api = new FakeApi().on('listProjects', () => [project('/Users/ada/code/r', 'github.com/o/r')])
    const { directory, world } = await setup(api)
    world.connections.connection('inst-a')
    await world.transports[0]!.accept()
    await flushPromises()
    const pr = { host: 'GitHub.com', owner: 'O', repo: 'R', number: 12 }
    expect(notificationRepositoryKey(pr)).toBe('github.com/o/r')
    expect(await directory.locate(pr, ['inst-a'])).toEqual({ hostId: 'inst-a', projectPath: '/Users/ada/code/r', number: 12 })
    expect(await directory.locate({ ...pr, repo: 'other' }, ['inst-a'])).toBeNull()
  })

  test('a pull request notification opens the pull request screen; others still say where they open', () => {
    const pr = { host: 'github.com', owner: 'o', repo: 'r', number: 3 }
    expect(nativeDestination({ kind: 'pr', pr })).toEqual({ kind: 'pull-request', pr })
    expect(nativeDestination({ kind: 'task', taskId: 't' }).kind).toBe('unsupported')
  })
})

describe('pull request presentation', () => {
  test('a draft reads as a draft, not as open', () => {
    expect(prStateTone({ state: 'open', draft: true })).toBe('draft')
    expect(prStateTone({ state: 'merged', draft: false })).toBe('merged')
  })

  test('the author may comment on their own pull request but not approve it', () => {
    const pr = pullRequest(1, { author: 'me' })
    expect(canGiveVerdict(pr, 'approve', 'me')).toBe(false)
    expect(canGiveVerdict(pr, 'comment', 'me')).toBe(true)
    expect(canGiveVerdict(pr, 'approve', 'someone-else')).toBe(true)
    const readOnly = pullRequest(2, { viewerPermissions: { ...pr.viewerPermissions, reviewVerdicts: [] } })
    expect(canGiveVerdict(readOnly, 'approve', 'reviewer')).toBe(false)
  })
})
