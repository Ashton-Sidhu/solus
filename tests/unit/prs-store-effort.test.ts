import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { IpcContext } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'
import { listingFrom, readFirstPage } from './__fixtures__/pr-listing'

const serverConnectionsMock = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: serverConnectionsMock,
}))

const api = () => serverConnectionsMock.apiFor('local')
const serverId = 'local'

const previousWindow = globalThis.window
const previousDocument = globalThis.document
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  serverConnectionsMock.reset()
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousDocument === undefined) delete (globalThis as unknown as { document?: Document }).document
  else Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: previousDocument })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const ctx = {
  session: { projectPath: '/repo', workingDirectory: '/repo' },
  window: {},
  settings: {},
  statusBar: {},
} as IpcContext

function listItem(): PullRequest {
  return pullRequestFixture(33, { title: 'Keep host selection stable', author: 'sidhu' })
}

function installWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      solus: listingFrom({
        prList: async () => ({ items: [listItem()], page: 1, hasMore: false }),
        prChecks: async () => { throw new Error('not relevant') },
        prGuideMetadata: async () => { throw new Error('not relevant') },
      }),
    },
  })
}

function installStateRune(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
}

describe('PR list cache', () => {
  test('keeps exact head-branch lookups in separate cache entries', async () => {
    // WHY: task discovery asks once per unique session branch. Reusing the
    // first branch response for every later branch would attach the wrong PR.
    installStateRune()
    const heads: Array<string | undefined> = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          prList: async (_ctx: IpcContext, filter: { head?: string }) => {
            heads.push(filter.head)
            return { items: [], page: 1, hasMore: false }
          },
        },
      },
    })
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    await store.get(api(), serverId, ctx).query({ state: 'all', head: 'fix/one' })
    await store.get(api(), serverId, ctx).query({ state: 'all', head: 'fix/two' })

    expect(heads).toEqual(['fix/one', 'fix/two'])
  })

  test('evicts old project entries instead of retaining every PR payload forever', async () => {
    // WHY: the store spans project switches. A TTL makes stale values unusable,
    // but without cardinality eviction their full provider payloads still stay
    // strongly reachable for the lifetime of the renderer.
    installStateRune()
    let detailCalls = 0
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          prGetDetail: async () => {
            detailCalls++
            return { number: 33, title: 'bounded' }
          },
        },
      },
    })
    const { PR_MIRROR_MAX_ENTRIES } = await import('@solus/workspace-ui/contexts/prs/pr-mirror')
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const project = store.get(api(), serverId, ctx)

    // A project's answers are held per pull request, so reading more of them
    // than the cap is what evicts — and the earliest one has to be asked again.
    for (let number = 1; number <= PR_MIRROR_MAX_ENTRIES + 1; number++) {
      await project.get(number).loadDetail()
    }
    await project.get(1).loadDetail()

    expect(detailCalls).toBe(PR_MIRROR_MAX_ENTRIES + 2)
  })

  test('publishes edited PR content to the list and detail cache', async () => {
    // WHY: saving from Activity must update every mounted PR surface instead of
    // leaving the list title and a warm detail cache on the pre-edit snapshot.
    installStateRune()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: listingFrom({
          prList: async () => ({ items: [listItem()], page: 1, hasMore: false }),
          prUpdate: async () => ({
            ...listItem(),
            title: 'Edited title',
            body: 'Edited description',
            updatedAt: '2026-01-02T00:00:00Z',
          }),
          prChecks: async () => { throw new Error('not relevant') },
          prGuideMetadata: async () => { throw new Error('not relevant') },
        }),
      },
    })
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    await readFirstPage(store, store.get(api(), serverId, ctx))

    await store.get(api(), serverId, ctx).get(33).update({
      title: 'Edited title',
      body: 'Edited description',
    })

    expect(store.get(api(), serverId, ctx).prFor(33)).toMatchObject({
      title: 'Edited title',
      body: 'Edited description',
    })
    expect(store.get(api(), serverId, ctx).get(33).cachedActivity().detail).toMatchObject({
      title: 'Edited title',
      body: 'Edited description',
    })
  })

  test('keeps the same PR context isolated between hosts', async () => {
    // WHY: the same checkout path and PR number can exist on two hosts with
    // different provider data. A cache hit from one host must not cross over.
    installStateRune()
    let hostACalls = 0
    let hostBCalls = 0
    serverConnectionsMock.registerPrimary('host-a', {
      prGetDetail: async () => ({ number: 33, title: `Host A ${++hostACalls}` }),
    })
    serverConnectionsMock.registerHost('host-b', {
      prGetDetail: async () => ({ number: 33, title: `Host B ${++hostBCalls}` }),
    })
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const hostA = await store.get(serverConnectionsMock.apiFor('host-a'), 'host-a', ctx).get(33).loadDetail()
    const hostB = await store.get(serverConnectionsMock.apiFor('host-b'), 'host-b', ctx).get(33).loadDetail()
    const hostAAgain = await store.get(serverConnectionsMock.apiFor('host-a'), 'host-a', ctx).get(33).loadDetail()
    const hostBAgain = await store.get(serverConnectionsMock.apiFor('host-b'), 'host-b', ctx).get(33).loadDetail()

    expect(hostA.title).toBe('Host A 1')
    expect(hostB.title).toBe('Host B 1')
    expect(hostAAgain.title).toBe('Host A 1')
    expect(hostBAgain.title).toBe('Host B 1')
    expect([hostACalls, hostBCalls]).toEqual([1, 1])
  })

  test('invalidates only the cache owned by the emitting host', async () => {
    // WHY: a checkout change on host A must not evict the same path and PR
    // cached for host B.
    installStateRune()
    let hostACalls = 0
    let hostBCalls = 0
    serverConnectionsMock.registerPrimary('host-a', {
      prGetDetail: async () => ({ number: 33, title: `Host A ${++hostACalls}` }),
    })
    serverConnectionsMock.registerHost('host-b', {
      prGetDetail: async () => ({ number: 33, title: `Host B ${++hostBCalls}` }),
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        setInterval: () => 1,
        clearInterval: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: { visibilityState: 'hidden' },
    })
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const hostAApi = serverConnectionsMock.apiFor('host-a')
    const hostBApi = serverConnectionsMock.apiFor('host-b')
    await store.get(hostAApi, 'host-a', ctx).get(33).loadDetail()
    await store.get(hostBApi, 'host-b', ctx).get(33).loadDetail()
    const { PrNeedsReviewStore } = await import('@solus/workspace-ui/contexts/prs/pr-needs-review.store.svelte')
    // The invalidation listener lives with needs-review, which is what reacts to
    // a project's pull requests changing.
    const needsReview = new PrNeedsReviewStore(store)
    const unsubscribe = needsReview.subscribe(() => ({ api: hostAApi, serverId: 'host-a', ctx }))

    serverConnectionsMock.emit('host-a', 'prs.invalidated', { projectRoot: '/repo' })
    await store.get(hostAApi, 'host-a', ctx).get(33).loadDetail()
    await store.get(hostBApi, 'host-b', ctx).get(33).loadDetail()
    unsubscribe()

    expect([hostACalls, hostBCalls]).toEqual([2, 1])
  })
})

describe('PR mutation results', () => {
  test('the store refreshes only observed interests on the invalidated or reconnected host', async () => {
    installStateRune()
    const reads: string[] = []
    for (const host of ['host-a', 'host-b']) {
      serverConnectionsMock.registerHost(host, {
        prList: async () => {
          reads.push(host)
          return { items: [listItem()], page: 1, hasMore: false }
        },
      })
    }
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore(() => Promise.resolve(), () => () => {})
    let settledA = Promise.withResolvers<void>()
    const settledB = Promise.withResolvers<void>()
    const projectA = store.get(serverConnectionsMock.apiFor('host-a'), 'host-a', ctx)
    const projectB = store.get(serverConnectionsMock.apiFor('host-b'), 'host-b', ctx)
    const releaseA = store.watch(projectA, { numbers: [33] }, () => settledA.resolve())
    const releaseB = store.watch(projectB, { numbers: [33] }, settledB.resolve)
    try {
      await Promise.all([settledA.promise, settledB.promise])
      expect(reads.toSorted()).toEqual(['host-a', 'host-b'])
      settledA = Promise.withResolvers<void>()
      serverConnectionsMock.emit('host-a', 'prs.invalidated', { projectRoot: '/repo' })
      await settledA.promise
      expect(reads.filter((host) => host === 'host-a')).toHaveLength(2)
      expect(reads.filter((host) => host === 'host-b')).toHaveLength(1)
      settledA = Promise.withResolvers<void>()
      serverConnectionsMock.emitStatus('host-a', 'connected')
      await settledA.promise
      expect(reads.filter((host) => host === 'host-a')).toHaveLength(3)
      releaseB()
      settledA = Promise.withResolvers<void>()
      serverConnectionsMock.emit('host-b', 'prs.invalidated', { projectRoot: '/repo' })
      serverConnectionsMock.emit('host-a', 'prs.invalidated', { projectRoot: '/repo' })
      await settledA.promise
      expect(reads.filter((host) => host === 'host-b')).toHaveLength(1)
    } finally {
      releaseA()
      releaseB()
    }
  })

  test('applies lifecycle events to the visible row, and a page already on the wire cannot undo them', async () => {
    // WHY: another connected client can change a PR while this list stays
    // mounted. Applying the delta must not wait for a provider reload, and a
    // read that left before the event must not restore the old draft value.
    installStateRune()
    installWindow()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    const project = store.get(api(), serverId, ctx)
    await readFirstPage(store, project)
    let answerLateRead: () => void = () => {}
    const lateRead = new Promise<void>((resolve) => { answerLateRead = resolve })
    Object.assign((globalThis as unknown as { window: { solus: object } }).window.solus, {
      prListProjects: async (_ctx: IpcContext, roots: string[]) => {
        await lateRead
        return roots.map((projectRoot) => ({ projectRoot, page: { items: [listItem()], page: 1, hasMore: false } }))
      },
    })
    const refreshing = readFirstPage(store, project)
    const unsubscribe = store.subscribeLifecycleChanges()
    const detail = {
      ...listItem(),
      draft: true,
      body: '',
      baseRef: 'main',
      headRef: 'feature',
      baseSha: 'base-33',
      changedFiles: 1,
      mergeable: true,
      mergeStateStatus: 'clean',
      headRepo: { owner: 'acme', repo: 'app', isFork: false },
      capabilities: {
        diff: true,
        diffFileContents: true,
        inlineComments: true,
        threadReplies: true,
        threadResolution: true,
        reviewVerdicts: ['comment', 'approve', 'request-changes'],
        actions: ['merge', 'close', 'reopen', 'ready', 'draft'],
        mergeMethods: ['squash'],
        reviewerRequests: true,
        reviewerCandidates: true,
        labelManagement: true,
      },
      viewerPermissions: {
        actions: ['ready'],
        reviewVerdicts: ['comment'],
        comment: true,
        resolveThreads: true,
        requestReviewers: false,
        manageLabels: false,
      },
    } satisfies PullRequest

    serverConnectionsMock.emit(serverId, 'pr.lifecycleChanged', { projectRoot: '/repo', detail })
    expect(store.get(api(), serverId, ctx).prFor(33)?.draft).toBe(true)

    answerLateRead()
    await refreshing
    expect(store.get(api(), serverId, ctx).prFor(33)?.draft).toBe(true)
    expect(project.loading).toBe(false)
    unsubscribe()
  })

  test('patches the visible row and detail cache without reloading the PR surface', async () => {
    // WHY: an in-UI lifecycle action already returns canonical provider state.
    // Reloading commits, comments, files, and threads adds latency and visual churn.
    installStateRune()
    installWindow()
    let detailLoads = 0
    const detail = {
      ...listItem(),
      state: 'closed',
      body: '',
      baseRef: 'main',
      headRef: 'feature',
      baseSha: 'base-33',
      changedFiles: 1,
      mergeable: true,
      mergeStateStatus: 'clean',
      headRepo: { owner: 'acme', repo: 'app', isFork: false },
      capabilities: {
        diff: true,
        diffFileContents: true,
        inlineComments: true,
        threadReplies: true,
        threadResolution: true,
        reviewVerdicts: ['comment', 'approve', 'request-changes'],
        actions: ['merge', 'close', 'reopen', 'ready', 'draft'],
        mergeMethods: ['squash'],
        reviewerRequests: true,
        reviewerCandidates: true,
        labelManagement: true,
      },
      viewerPermissions: {
        actions: ['reopen'],
        reviewVerdicts: ['comment', 'approve', 'request-changes'],
        comment: true,
        resolveThreads: true,
        requestReviewers: true,
        manageLabels: true,
      },
    } satisfies PullRequest
    Object.assign((globalThis as unknown as { window: { solus: object } }).window.solus, {
      prGetDetail: async () => {
        detailLoads++
        throw new Error('The mutation result should seed this cache')
      },
      prUpdateLifecycle: async () => detail,
    })
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    await readFirstPage(store, store.get(api(), serverId, ctx))

    await store.get(api(), serverId, ctx).get(33).updateLifecycle('close', 'head-33')

    expect(store.get(api(), serverId, ctx).prFor(33)?.state).toBe('closed')
    // The mutation's own answer seeded the cache, so reading the detail after it
    // must not reach the host — `prGetDetail` throws if anything does.
    expect((await store.get(api(), serverId, ctx).get(33).loadDetail()).state).toBe('closed')
    expect(detailLoads).toBe(0)

    const mergedDetail = { ...detail, state: 'merged' as const }
    store.at(serverId, ctx.session.projectPath)?.applyPullRequest(mergedDetail)
    expect(store.get(api(), serverId, ctx).prFor(33)?.state).toBe('merged')
    expect((await store.get(api(), serverId, ctx).get(33).loadDetail()).state).toBe('merged')
  })

  test('shows a host write at once and takes back only that write when the host refuses', async () => {
    // WHY: every surface reads the one pull request, so an armed auto-merge or a
    // close must show everywhere at once — and a refusal must restore exactly
    // those fields, never blank the rest of the pull request.
    installStateRune()
    installWindow()
    const refusals: Array<(error: Error) => void> = []
    const refused = () => new Promise<PullRequest>((_resolve, reject) => refusals.push(reject))
    Object.assign((globalThis as unknown as { window: { solus: object } }).window.solus, {
      prEnableAutoMerge: refused,
      prUpdateLifecycle: refused,
    })
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()
    await readFirstPage(store, store.get(api(), serverId, ctx))
    const pullRequest = store.get(api(), serverId, ctx).get(33)

    const arming = pullRequest.enableAutoMerge('squash')
    expect(pullRequest.autoMergeEnabled).toBe(true)
    expect(pullRequest.autoMergeMethod).toBe('squash')
    refusals[0](new Error('Auto-merge is not allowed'))
    await expect(arming).rejects.toThrow('Auto-merge is not allowed')
    expect(pullRequest.autoMergeEnabled).toBeUndefined()
    expect(pullRequest.autoMergeMethod).toBeUndefined()

    const closing = pullRequest.updateLifecycle('close', pullRequest.headSha)
    expect(store.get(api(), serverId, ctx).prFor(33)?.state).toBe('closed')
    refusals[1](new Error('Not allowed'))
    await expect(closing).rejects.toThrow('Not allowed')
    expect(pullRequest.state).toBe('open')
    expect(pullRequest.title).toBe('Keep host selection stable')
  })
})

describe('needs-review refresh cadence', () => {
  test('the count follows the poll, not the window; a return to the window asks nothing', async () => {
    installStateRune()
    let reads = 0
    serverConnectionsMock.registerPrimary('local', {
      prNeedsReview: async () => { reads += 1; return [] },
    })
    const listeners: string[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        setInterval: () => 1,
        clearInterval: () => {},
        addEventListener: (type: string) => { listeners.push(type) },
        removeEventListener: () => {},
      },
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: { visibilityState: 'visible' },
    })

    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrNeedsReviewStore } = await import('@solus/workspace-ui/contexts/prs/pr-needs-review.store.svelte')
    const needsReview = new PrNeedsReviewStore(new PrsStore())
    const unsubscribe = needsReview.subscribe(() => ({ api: api(), serverId, ctx }))
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(1)

    // Whether this window is looked at bears no relation to whether someone
    // else asked for a review, so the store must not listen for it at all.
    expect(listeners).not.toContain('focus')

    // Editing a pull request here does change what is being asked of us.
    serverConnectionsMock.emit(serverId, 'prs.invalidated', { projectRoot: '/repo' })
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(2)
    unsubscribe()
  })
})
