import { afterEach, describe, expect, test } from 'bun:test'
import type { PrFilter, PrListPage, PullRequest } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { IpcContext } from '@solus/contracts/types'
import type { StackGraph } from '@solus/contracts/stack-types'
import { asHostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import {
  flattenQualifiedProjects,
  qualifiedPrKey,
  qualifiedStackParentOf,
  type QualifiedProject,
} from '@solus/workspace-ui/components/prs/lib/pr-cross-project'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

function installStateRune(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
}

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function ctxFor(projectPath: string): IpcContext {
  return {
    session: { projectPath, workingDirectory: projectPath },
    window: {},
    settings: {},
    statusBar: {},
  } as IpcContext
}

function pr(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return pullRequestFixture(number, { title: `PR #${number}`, headSha: `sha-${number}`, ...overrides })
}

describe('PrsStore cross-project scopes', () => {
  test('merges every project\'s pull requests into one list', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const apiA = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1), pr(2)], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
      prGuideMetadata: async () => null,
    })
    const apiB = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1), pr(3)], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'b' }, checks: [] }),
      prGuideMetadata: async () => null,
    })

    await store.listAll([
      { serverId: 'host-a', projectRoot: '/repos/a', label: 'A', api: apiA, ctx: ctxFor('/repos/a') },
      { serverId: 'host-b', projectRoot: '/repos/b', label: 'B', api: apiB, ctx: ctxFor('/repos/b') },
    ], { state: 'open' })

    expect(store.all.flatMap((project) => project.items)).toHaveLength(4)
    expect(store.at('host-a', '/repos/a')?.items.map((item) => item.number)).toEqual([1, 2])
    expect(store.at('host-b', '/repos/b')?.items.map((item) => item.number)).toEqual([1, 3])
  })

  test('a partial failure keeps the successful projects visible instead of hiding them', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const apiOk = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1)], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'ok' }, checks: [] }),
      prGuideMetadata: async () => null,
    })
    const apiFailing = asHostApi({
      prList: async (): Promise<PrListPage> => { throw new Error('host unreachable') },
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'bad' }, checks: [] }),
      prGuideMetadata: async () => null,
    })

    await store.listAll([
      { serverId: 'host-ok', projectRoot: '/repos/ok', label: 'OK', api: apiOk, ctx: ctxFor('/repos/ok') },
      { serverId: 'host-bad', projectRoot: '/repos/bad', label: 'Bad', api: apiFailing, ctx: ctxFor('/repos/bad') },
    ], { state: 'open' })

    expect(store.at('host-ok', '/repos/ok')?.items).toHaveLength(1)
    expect(store.at('host-ok', '/repos/ok')?.error).toBeNull()
    expect(store.at('host-bad', '/repos/bad')?.error).not.toBeNull()
    // The failing project contributes nothing, but the working one is untouched.
    expect(store.all.flatMap((project) => project.items).map((item) => item.number)).toEqual([1])
  })

  test('a failed refresh keeps the last-safe snapshot instead of blanking a project that once loaded', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    let call = 0
    const api = asHostApi({
      prList: async (): Promise<PrListPage> => {
        call++
        if (call === 1) return { items: [pr(1)], page: 1, hasMore: false }
        throw new Error('transient failure')
      },
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'x' }, checks: [] }),
      prGuideMetadata: async () => null,
    })
    const projects = [{ serverId: 'host-a', projectRoot: '/repos/a', label: 'A', api, ctx: ctxFor('/repos/a') }]

    await store.listAll(projects, { state: 'open' })
    expect(store.at('host-a', '/repos/a')?.items).toHaveLength(1)

    await store.listAll(projects, { state: 'open' }, { force: true })
    expect(store.at('host-a', '/repos/a')?.error).not.toBeNull()
    expect(store.at('host-a', '/repos/a')?.items).toHaveLength(1)
  })

  // WHY: My Workspace and any other folder without a remote can never answer
  // this call. Asking again on every refresh spends a worker slot a real
  // repository needs, so the answer is remembered until an explicit refresh.
  test('asks a project with no git remote once, and retries only on an explicit refresh', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    let calls = 0
    const api = asHostApi({
      prList: async (): Promise<PrListPage> => {
        calls++
        throw new Error('This folder has no recognizable git remote to review PRs from.')
      },
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'x' }, checks: [] }),
      prGuideMetadata: async () => null,
    })
    const projects = [{ serverId: 'host-a', projectRoot: '/workspace', label: 'My Workspace', api, ctx: ctxFor('/workspace') }]

    await store.listAll(projects, { state: 'open' })
    expect(store.at('host-a', '/workspace')?.error?.kind).toBe('no-repository')
    expect(calls).toBe(1)

    await store.listAll(projects, { state: 'open' })
    expect(calls).toBe(1)

    await store.listAll(projects, { state: 'open' }, { force: true })
    expect(calls).toBe(2)
  })

  test('bounds how many projects load in parallel', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    let inFlight = 0
    let maxInFlight = 0
    const projects = Array.from({ length: 8 }, (_unused, index) => ({
      serverId: `host-${index}`,
      projectRoot: `/repos/${index}`,
      label: `Project ${index}`,
      api: asHostApi({
        prList: async (): Promise<PrListPage> => {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight--
          return { items: [pr(index)], page: 1, hasMore: false }
        },
        prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: String(index) }, checks: [] }),
        prGuideMetadata: async () => null,
      }),
      ctx: ctxFor(`/repos/${index}`),
    }))

    await store.listAll(projects, { state: 'open' }, { concurrency: 3 })

    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(store.all.flatMap((project) => project.items)).toHaveLength(8)
  })

  test('a stale response cannot land after a newer refresh has begun', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const slowGate: { resolve: (() => void) | null } = { resolve: null }
    const slowApi = asHostApi({
      prList: async (): Promise<PrListPage> => {
        await new Promise<void>((resolve) => { slowGate.resolve = resolve })
        return { items: [pr(999, { title: 'stale' })], page: 1, hasMore: false }
      },
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'x' }, checks: [] }),
      prGuideMetadata: async () => null,
    })
    const fastApi = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1, { title: 'fresh' })], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'x' }, checks: [] }),
      prGuideMetadata: async () => null,
    })
    const project = { serverId: 'host-a', projectRoot: '/repos/a', label: 'A', ctx: ctxFor('/repos/a') }

    const firstLoad = store.listAll([{ ...project, api: slowApi }], { state: 'open' })
    // A scope change starts a second, newer load before the first's slow
    // response has arrived.
    const secondLoad = store.listAll([{ ...project, api: fastApi }], { state: 'open' }, { force: true })
    await secondLoad
    slowGate.resolve?.()
    await firstLoad

    expect(store.at('host-a', '/repos/a')?.items.map((item) => item.title)).toEqual(['fresh'])
  })

  test('loadMore paginates only the named project, leaving others untouched', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const apiA = asHostApi({
      prList: async (_ctx: IpcContext, _filter: unknown, page = 1): Promise<PrListPage> =>
        page === 1
          ? { items: [pr(1)], page: 1, hasMore: true }
          : { items: [pr(2)], page: 2, hasMore: false },
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
      prGuideMetadata: async () => null,
    })
    const apiB = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1)], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'b' }, checks: [] }),
      prGuideMetadata: async () => null,
    })

    await store.listAll([
      { serverId: 'host-a', projectRoot: '/repos/a', label: 'A', api: apiA, ctx: ctxFor('/repos/a') },
      { serverId: 'host-b', projectRoot: '/repos/b', label: 'B', api: apiB, ctx: ctxFor('/repos/b') },
    ], { state: 'open' })

    await store.at('host-a', '/repos/a')!.list({ page: store.at('host-a', '/repos/a')!.nextPage })

    expect(store.at('host-a', '/repos/a')?.items.map((item) => item.number)).toEqual([1, 2])
    expect(store.at('host-a', '/repos/a')?.hasMore).toBe(false)
    expect(store.at('host-b', '/repos/b')?.items.map((item) => item.number)).toEqual([1])
  })

})

describe('PrsStore cross-project reading flags', () => {
  function deferredPage(): { promise: Promise<PrListPage>; resolve: (page: PrListPage) => void } {
    let resolve: (page: PrListPage) => void = () => {}
    const promise = new Promise<PrListPage>((settle) => { resolve = settle })
    return { promise, resolve }
  }

  // WHY: the footer offers "Load more" and reads pagination off this flag. A
  // refresh raises `loading` on every project that has already read, so taking
  // pagination from that flag put a disabled "Loading…" footer under a list
  // with no further page every time the page refreshed or the scope changed.
  test('a refresh is reading, but it is not pagination', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const refreshed = deferredPage()
    let calls = 0
    const api = asHostApi({
      prList: async (): Promise<PrListPage> =>
        ++calls === 1 ? { items: [pr(1)], page: 1, hasMore: false } : refreshed.promise,
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
      prGuideMetadata: async () => null,
    })
    const projects = [{ serverId: 'h', projectRoot: '/repos/a', label: 'A', api, ctx: ctxFor('/repos/a') }]

    await store.listAll(projects, { state: 'open' })
    const refresh = store.listAll(projects, { state: 'open' }, { force: true })

    expect(store.all.some((project) => project.loading)).toBe(true)
    expect(store.at('h', '/repos/a')?.loadingMore).toBe(false)

    refreshed.resolve({ items: [pr(1)], page: 1, hasMore: false })
    await refresh
    expect(store.at('h', '/repos/a')?.loadingMore).toBe(false)
  })

  test('appending a page is the one thing that reports as pagination', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    const second = deferredPage()
    const api = asHostApi({
      prList: async (_ctx: IpcContext, _filter: PrFilter, page = 1): Promise<PrListPage> =>
        page === 1 ? { items: [pr(1)], page: 1, hasMore: true } : second.promise,
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
      prGuideMetadata: async () => null,
    })

    await store.listAll([
      { serverId: 'h', projectRoot: '/repos/a', label: 'A', api, ctx: ctxFor('/repos/a') },
    ], { state: 'open' })

    const project = store.at('h', '/repos/a')!
    const more = project.list({ page: project.nextPage })
    expect(store.at('h', '/repos/a')?.loadingMore).toBe(true)

    second.resolve({ items: [pr(2)], page: 2, hasMore: false })
    await more
    expect(store.at('h', '/repos/a')?.loadingMore).toBe(false)
  })
})

describe('qualified PR identity', () => {
  function project(serverId: string, projectRoot: string, items: PullRequest[]): QualifiedProject {
    return {
      serverId,
      projectRoot,
      label: projectRoot,
      api: asHostApi({}),
      ctx: ctxFor(projectRoot),
      items,
    }
  }

  test('the same PR number from two repos stays two independent rows', () => {
    const { byKey, byPr } = flattenQualifiedProjects([
      project('host-a', '/repos/a', [pr(7, { title: 'Repo A #7' })]),
      project('host-b', '/repos/b', [pr(7, { title: 'Repo B #7' })]),
    ])

    const keyA = qualifiedPrKey('host-a', '/repos/a', 7)
    const keyB = qualifiedPrKey('host-b', '/repos/b', 7)
    expect(keyA).not.toBe(keyB)
    expect(byKey.get(keyA)?.pr.title).toBe('Repo A #7')
    expect(byKey.get(keyB)?.pr.title).toBe('Repo B #7')
    expect(byKey.get(keyA)?.label).toBe('/repos/a')
    expect(byKey.get(keyB)?.label).toBe('/repos/b')
    expect(byPr.size).toBe(2)
  })

  test('resolves each row back to its own project, never the other one', () => {
    const prA = pr(7)
    const prB = pr(7)
    const { byPr } = flattenQualifiedProjects([
      project('host-a', '/repos/a', [prA]),
      project('host-b', '/repos/b', [prB]),
    ])

    expect(byPr.get(prA)?.serverId).toBe('host-a')
    expect(byPr.get(prB)?.serverId).toBe('host-b')
  })
})

describe('qualifiedStackParentOf', () => {
  function graph(edges: StackGraph['edges']): StackGraph {
    return { edges, headShas: {}, detectedAt: '2026-01-01T00:00:00.000Z' }
  }

  function fakeStacksStore(graphs: Map<string, StackGraph>) {
    return {
      parentOf: (prNumber: number, serverId: string, repoRoot: string) =>
        graphs.get(`${serverId}\0${repoRoot}`)?.edges.find((edge) => edge.child === prNumber)?.parent ?? null,
    } as import('@solus/workspace-ui/contexts/prs/stacks.store.svelte').StacksStore
  }

  test('a stack edge in one repo never attaches to the same PR number in another', () => {
    const graphs = new Map<string, StackGraph>([
      ['host-a\0/repos/a', graph([{ parent: 10, child: 20, source: 'ancestry' }])],
    ])
    const stacks = fakeStacksStore(graphs)

    const prTwentyRepoA = pr(20)
    const prTwentyRepoB = pr(20)
    const { byPr } = flattenQualifiedProjects([
      { serverId: 'host-a', projectRoot: '/repos/a', label: 'A', api: asHostApi({}), ctx: ctxFor('/repos/a'), items: [prTwentyRepoA] },
      { serverId: 'host-b', projectRoot: '/repos/b', label: 'B', api: asHostApi({}), ctx: ctxFor('/repos/b'), items: [prTwentyRepoB] },
    ])
    const stackParentOf = qualifiedStackParentOf(stacks, byPr)

    expect(stackParentOf(prTwentyRepoA)).toBe(10)
    // Repo B has no graph at all — its identically-numbered PR must not
    // inherit repo A's edge.
    expect(stackParentOf(prTwentyRepoB)).toBeNull()
  })
})
