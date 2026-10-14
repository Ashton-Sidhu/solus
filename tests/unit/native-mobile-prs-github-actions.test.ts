import { describe, expect, test } from 'bun:test'
import type { PrStack, PrViewedFileChange } from '@solus/contracts/providers'
import { PullRequestActions } from '../../apps/mobile/src/features/prs/pull-request-actions'
import { memoryPullRequestCacheDatabase, PullRequestCache } from '../../apps/mobile/src/features/prs/pull-request-cache'
import { PullRequestDirectory } from '../../apps/mobile/src/features/prs/pull-request-directory'
import { PullRequestReviewDrafts } from '../../apps/mobile/src/features/prs/pull-request-review-drafts'
import { shownValue } from '../../apps/mobile/src/features/prs/pull-request-reads'
import { pullRequestPermissions, stackMergePlan, viewedFilesOnHost } from '../../apps/mobile/src/features/prs/lib/pull-request-permissions'
import { FakeApi, flushPromises, ManualTimers } from './helpers/native-mobile-fakes'
import { detailApi, hostWorld, PR_REF, project, pullRequest } from './helpers/native-mobile-prs-fixtures'

// Stack merge, workflow approval, revert, and viewed files change GitHub. Each
// must show only when GitHub and the person's account both allow it, name what
// the person was shown, and read again what it changed.

async function setup(api: FakeApi, options: { connected?: boolean } = { connected: true }) {
  const world = await hostWorld(api, options)
  const connectionFor = (hostId: string) => world.connections.connection(hostId)
  const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
  const directory = new PullRequestDirectory(connectionFor, () => null, cache)
  const timers = new ManualTimers()
  const actions = new PullRequestActions({
    connectionFor,
    organizationId: () => null,
    directory,
    drafts: new PullRequestReviewDrafts(cache, () => 'id'),
    startSession: () => 'session',
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  })
  return { world, directory, actions, timers, cache }
}

const allowed = (...actions: ('merge-stack' | 'revert' | 'approve-workflows')[]) => ({
  capabilities: { ...pullRequest(7).capabilities, actions, mergeMethods: ['squash' as const] },
  viewerPermissions: { ...pullRequest(7).viewerPermissions, actions },
})

const stack = (layers: PrStack['layers']): PrStack => ({ number: 90, url: 'https://github.com/o/r/stacks/90', base: 'main', layers })
const layer = (number: number, overrides: Partial<PrStack['layers'][number]> = {}) => ({
  number, title: `PR ${number}`, headRef: `b${number}`, headSha: `head-${number}`, state: 'open' as const, draft: false, ...overrides,
})

const listing = (api: FakeApi) => api
  .on('listProjects', () => [project('/work/app', 'github.com/o/r')])
  .on('prListProjects', () => [])
  .on('providerViewer', () => ({ login: 'me' }))

describe('stack merge', () => {
  test('is offered only when GitHub and the account both allow it and the pull request is in a stack', () => {
    const layers = stack([layer(5), layer(7)])
    expect(stackMergePlan(pullRequest(7, allowed('merge-stack')), layers, true, 'squash')).not.toBeNull()
    expect(stackMergePlan(pullRequest(7, allowed('merge-stack')), null, true, 'squash')).toBeNull()
    const capabilityOnly = pullRequest(7, { capabilities: allowed('merge-stack').capabilities })
    expect(stackMergePlan(capabilityOnly, layers, true, 'squash')).toBeNull()
    const permissionOnly = pullRequest(7, { viewerPermissions: allowed('merge-stack').viewerPermissions })
    expect(stackMergePlan(permissionOnly, layers, true, 'squash')).toBeNull()
  })

  test('sends the shown heads of the open layers from the bottom up to this one', () => {
    const plan = stackMergePlan(pullRequest(7, allowed('merge-stack')), stack([layer(3, { state: 'merged' }), layer(5), layer(7), layer(9)]), true, 'squash')
    expect(plan?.reason).toBeNull()
    expect(plan?.expectedHeads).toEqual([{ number: 5, headSha: 'head-5' }, { number: 7, headSha: 'head-7' }])
  })

  test('the bottom open layer is a stack merge of one layer, as on desktop and web', () => {
    const plan = stackMergePlan(pullRequest(5, allowed('merge-stack')), stack([layer(3, { state: 'merged' }), layer(5), layer(7)]), true, 'squash')
    expect(plan?.reason).toBeNull()
    expect(plan?.layers.map((entry) => entry.number)).toEqual([5])
  })

  test('says why it cannot run: offline, a draft or closed layer, or a head the device does not know', () => {
    const pr = pullRequest(7, allowed('merge-stack'))
    expect(stackMergePlan(pr, stack([layer(5), layer(7)]), false, 'squash')?.reason).toBe('Connect to this host to merge the stack.')
    expect(stackMergePlan(pr, stack([layer(5, { draft: true }), layer(7)]), true, 'squash')?.reason).toContain('ready for review')
    expect(stackMergePlan(pr, stack([layer(5, { state: 'closed' }), layer(7)]), true, 'squash')?.reason).toContain('Reopen')
    expect(stackMergePlan(pr, stack([layer(5, { headSha: undefined }), layer(7)]), true, 'squash')?.reason).toContain('Read the stack again')
  })

  test('merges through the host, then reads the pull request and the host list again', async () => {
    const api = listing(detailApi(new FakeApi()))
      .on('prMergeStack', () => ({ status: 'queued', pullRequests: [] }))
    const { actions } = await setup(api)
    const result = await actions.mergeStack(PR_REF, { stackNumber: 90, method: 'squash', expectedHeads: [{ number: 7, headSha: 'head-7' }] })
    expect(result.status).toBe('queued')
    expect(api.callsOf('prMergeStack')[0]![1]).toEqual({ number: 7, stackNumber: 90, method: 'squash', expectedHeads: [{ number: 7, headSha: 'head-7' }] })
    expect(api.callsOf('prGetOverview')).toHaveLength(1)
    expect(api.callsOf('prListProjects')).toHaveLength(1)
  })
})

describe('workflow approval', () => {
  const fork = { ...allowed('approve-workflows'), headRepo: { owner: 'fork', repo: 'r', isFork: true } }

  test('the waiting runs of an open fork pull request are part of the detail and of its device copy', async () => {
    const runs = { headSha: 'head-7', runs: [{ id: 1, name: 'CI', url: null }] }
    const api = detailApi(new FakeApi(), () => pullRequest(7, fork)).on('prPendingWorkflowRuns', () => runs)
    const { directory, cache } = await setup(api)
    await directory.loadDetail(PR_REF)
    expect(shownValue(directory.detailOf(PR_REF))?.workflowRuns).toEqual(runs)
    await flushPromises()
    const kept = await cache.read<{ workflowRuns?: unknown }>('inst-a', 'detail:/work/app:7')
    expect(kept?.workflowRuns).toEqual(runs)
  })

  test('runs that cannot be read do not hide the rest of the pull request', async () => {
    const api = detailApi(new FakeApi(), () => pullRequest(7, fork)).on('prPendingWorkflowRuns', () => { throw new Error('nope') })
    const { directory } = await setup(api)
    await directory.loadDetail(PR_REF)
    const detail = directory.detailOf(PR_REF)
    expect(detail.kind).toBe('loaded')
    expect(shownValue(detail)?.missing).toEqual(['workflowRuns'])
  })

  test('a pull request that is not from a fork asks nothing', async () => {
    const api = detailApi(new FakeApi(), () => pullRequest(7, allowed('approve-workflows')))
    const { directory } = await setup(api)
    await directory.loadDetail(PR_REF)
    expect(api.callsOf('prPendingWorkflowRuns')).toHaveLength(0)
  })

  test('approval names the head the runs belong to and reads the pull request again', async () => {
    const api = detailApi(new FakeApi(), () => pullRequest(7, fork))
      .on('prPendingWorkflowRuns', () => ({ headSha: 'head-7', runs: [] }))
      .on('prApproveWorkflowRuns', () => ({ approved: 2 }))
    const { actions } = await setup(api)
    expect(await actions.approveWorkflowRuns(PR_REF, 'head-7')).toBe(2)
    expect(api.callsOf('prApproveWorkflowRuns')[0]!.slice(1)).toEqual([7, 'head-7'])
    expect(api.callsOf('prGetOverview')).toHaveLength(1)
    expect(pullRequestPermissions(pullRequest(7, fork), 'me', true).canApproveWorkflows).toBe(true)
    expect(pullRequestPermissions(pullRequest(7, { capabilities: fork.capabilities }), 'me', true).canApproveWorkflows).toBe(false)
  })
})

describe('revert', () => {
  test('is offered for a merged pull request when GitHub and the account both allow it', () => {
    expect(pullRequestPermissions(pullRequest(7, { ...allowed('revert'), state: 'merged' }), 'me', true).canRevert).toBe(true)
    expect(pullRequestPermissions(pullRequest(7, { ...allowed('revert'), state: 'open' }), 'me', true).canRevert).toBe(false)
    expect(pullRequestPermissions(pullRequest(7, { ...allowed('revert'), state: 'merged' }), 'me', false).canRevert).toBe(false)
    const permissionOnly = pullRequest(7, { viewerPermissions: allowed('revert').viewerPermissions, state: 'merged' })
    expect(pullRequestPermissions(permissionOnly, 'me', true).canRevert).toBe(false)
  })

  test('answers the new pull request on the same host and project, to open it', async () => {
    const api = listing(detailApi(new FakeApi())).on('prRevert', () => ({ number: 12, url: 'https://github.com/o/r/pull/12' }))
    const { actions } = await setup(api)
    expect(await actions.revert(PR_REF)).toEqual({ hostId: 'inst-a', projectPath: '/work/app', number: 12 })
  })
})

describe('viewed files on GitHub', () => {
  const viewedApi = () => {
    let files = [{ path: 'a.ts', state: 'unviewed' as const }, { path: 'b.ts', state: 'dismissed' as const }]
    const api = new FakeApi()
      .on('prViewedFiles', () => ({ files, complete: true }))
      .on('prSetFilesViewed', (_ctx: never, _number: never, changes: PrViewedFileChange[]) => {
        files = files.map((file) => {
          const change = changes.find((entry) => entry.path === file.path)
          return change ? { ...file, state: change.viewed ? 'viewed' : 'unviewed' } : file
        }) as typeof files
      })
    return api
  }

  test('marks show at once and go in one write after the taps stop, then GitHub is read again', async () => {
    const api = viewedApi()
    const { actions, directory, timers } = await setup(api)
    await directory.loadViewed(PR_REF)
    actions.markFileViewed(PR_REF, 'a.ts', true)
    actions.markFileViewed(PR_REF, 'b.ts', true)
    expect(actions.viewedMarksOf(PR_REF).get('a.ts')).toBe(true)
    expect(api.callsOf('prSetFilesViewed')).toHaveLength(0)
    timers.runAll()
    await flushPromises()
    await flushPromises()
    expect(api.callsOf('prSetFilesViewed')[0]![2]).toEqual([{ path: 'a.ts', viewed: true }, { path: 'b.ts', viewed: true }])
    expect(api.callsOf('prViewedFiles')).toHaveLength(2)
    expect(shownValue(directory.viewedOf(PR_REF))?.files.every((file) => file.state === 'viewed')).toBe(true)
    expect(actions.viewedMarksOf(PR_REF).size).toBe(0)
  })

  test('a failed write takes the marks back and keeps a short reason', async () => {
    const api = viewedApi().on('prSetFilesViewed', () => { throw new Error('GitHub refused the change.') })
    const { actions, directory } = await setup(api)
    await directory.loadViewed(PR_REF)
    actions.markFileViewed(PR_REF, 'a.ts', true)
    await actions.sendViewed(PR_REF)
    expect(actions.viewedMarksOf(PR_REF).has('a.ts')).toBe(false)
    expect(actions.viewedErrorOf(PR_REF)).toBe('GitHub refused the change.')
    actions.markFileViewed(PR_REF, 'a.ts', true)
    expect(actions.viewedErrorOf(PR_REF)).toBeNull()
  })

  test('offline, the device copy still shows, and a mark is refused without a call', async () => {
    const online = await setup(viewedApi())
    await online.directory.loadViewed(PR_REF)
    await flushPromises()
    const api = viewedApi()
    const offline = await setup(api, { connected: false })
    // The same device copy, under the same key, in a new store.
    const copy = await online.cache.read('inst-a', 'viewed-files:/work/app:7')
    await offline.cache.write('inst-a', 'viewed-files:/work/app:7', copy)
    await offline.directory.loadViewed(PR_REF)
    expect(shownValue(offline.directory.viewedOf(PR_REF))?.files).toHaveLength(2)
    expect(() => offline.actions.markFileViewed(PR_REF, 'a.ts', true)).toThrow('Connect to this host')
    expect(api.callsOf('prSetFilesViewed')).toHaveLength(0)
  })

  test('a host without the flag, or one commit, keeps the marks on the device', () => {
    const supported = pullRequest(7, { capabilities: { ...pullRequest(7).capabilities, viewedFiles: true } })
    expect(viewedFilesOnHost(supported, null)).toBe(true)
    expect(viewedFilesOnHost(supported, 'abc')).toBe(false)
    expect(viewedFilesOnHost(pullRequest(7), null)).toBe(false)
  })
})
