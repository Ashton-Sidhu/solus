import { afterEach, describe, expect, test } from 'bun:test'
import type { PrListPage, PullRequestSummary } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import type { StackGraph } from '@solus/contracts/stack-types'
import { asHostApi } from '@solus/client-core/host-api'
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

function pr(number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number,
    title: `PR #${number}`,
    headSha: `sha-${number}`,
    author: 'octocat',
    authorAvatarUrl: '',
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
    ...overrides,
  }
}

describe('PrInboxStore aggregation', () => {
  test('merges every project\'s pull requests into one list', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrInboxStore } = await import('@solus/workspace-ui/contexts/prs/pr-inbox.store.svelte')
    const store = new PrsStore()
    const inbox = new PrInboxStore()

    const apiA = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1), pr(2)], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
      prGuideMetadata: async () => [],
    })
    const apiB = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1), pr(3)], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'b' }, checks: [] }),
      prGuideMetadata: async () => [],
    })

    await inbox.loadAll(store, [
      { serverId: 'host-a', projectRoot: '/repos/a', label: 'A', api: apiA, ctx: ctxFor('/repos/a') },
      { serverId: 'host-b', projectRoot: '/repos/b', label: 'B', api: apiB, ctx: ctxFor('/repos/b') },
    ], { state: 'open' })

    expect(inbox.allItems).toHaveLength(4)
    expect(inbox.stateFor('host-a', '/repos/a')?.items.map((item) => item.number)).toEqual([1, 2])
    expect(inbox.stateFor('host-b', '/repos/b')?.items.map((item) => item.number)).toEqual([1, 3])
  })

  test('a partial failure keeps the successful projects visible instead of hiding them', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrInboxStore } = await import('@solus/workspace-ui/contexts/prs/pr-inbox.store.svelte')
    const store = new PrsStore()
    const inbox = new PrInboxStore()

    const apiOk = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1)], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'ok' }, checks: [] }),
      prGuideMetadata: async () => [],
    })
    const apiFailing = asHostApi({
      prList: async (): Promise<PrListPage> => { throw new Error('host unreachable') },
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'bad' }, checks: [] }),
      prGuideMetadata: async () => [],
    })

    await inbox.loadAll(store, [
      { serverId: 'host-ok', projectRoot: '/repos/ok', label: 'OK', api: apiOk, ctx: ctxFor('/repos/ok') },
      { serverId: 'host-bad', projectRoot: '/repos/bad', label: 'Bad', api: apiFailing, ctx: ctxFor('/repos/bad') },
    ], { state: 'open' })

    expect(inbox.stateFor('host-ok', '/repos/ok')?.items).toHaveLength(1)
    expect(inbox.stateFor('host-ok', '/repos/ok')?.error).toBeNull()
    expect(inbox.stateFor('host-bad', '/repos/bad')?.error).not.toBeNull()
    // The failing project contributes nothing, but the working one is untouched.
    expect(inbox.allItems.map((item) => item.number)).toEqual([1])
  })

  test('a failed refresh keeps the last-safe snapshot instead of blanking a project that once loaded', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrInboxStore } = await import('@solus/workspace-ui/contexts/prs/pr-inbox.store.svelte')
    const store = new PrsStore()
    const inbox = new PrInboxStore()

    let call = 0
    const api = asHostApi({
      prList: async (): Promise<PrListPage> => {
        call++
        if (call === 1) return { items: [pr(1)], page: 1, hasMore: false }
        throw new Error('transient failure')
      },
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'x' }, checks: [] }),
      prGuideMetadata: async () => [],
    })
    const projects = [{ serverId: 'host-a', projectRoot: '/repos/a', label: 'A', api, ctx: ctxFor('/repos/a') }]

    await inbox.loadAll(store, projects, { state: 'open' })
    expect(inbox.stateFor('host-a', '/repos/a')?.items).toHaveLength(1)

    await inbox.loadAll(store, projects, { state: 'open' }, { force: true })
    expect(inbox.stateFor('host-a', '/repos/a')?.error).not.toBeNull()
    expect(inbox.stateFor('host-a', '/repos/a')?.items).toHaveLength(1)
  })

  test('bounds how many projects load in parallel', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrInboxStore } = await import('@solus/workspace-ui/contexts/prs/pr-inbox.store.svelte')
    const store = new PrsStore()
    const inbox = new PrInboxStore()

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
        prGuideMetadata: async () => [],
      }),
      ctx: ctxFor(`/repos/${index}`),
    }))

    await inbox.loadAll(store, projects, { state: 'open' }, { concurrency: 3 })

    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(inbox.allItems).toHaveLength(8)
  })

  test('a stale response cannot land after a newer refresh has begun', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrInboxStore } = await import('@solus/workspace-ui/contexts/prs/pr-inbox.store.svelte')
    const store = new PrsStore()
    const inbox = new PrInboxStore()

    const slowGate: { resolve: (() => void) | null } = { resolve: null }
    const slowApi = asHostApi({
      prList: async (): Promise<PrListPage> => {
        await new Promise<void>((resolve) => { slowGate.resolve = resolve })
        return { items: [pr(999, { title: 'stale' })], page: 1, hasMore: false }
      },
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'x' }, checks: [] }),
      prGuideMetadata: async () => [],
    })
    const fastApi = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1, { title: 'fresh' })], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'x' }, checks: [] }),
      prGuideMetadata: async () => [],
    })
    const project = { serverId: 'host-a', projectRoot: '/repos/a', label: 'A', ctx: ctxFor('/repos/a') }

    const firstLoad = inbox.loadAll(store, [{ ...project, api: slowApi }], { state: 'open' })
    // A scope change starts a second, newer load before the first's slow
    // response has arrived.
    const secondLoad = inbox.loadAll(store, [{ ...project, api: fastApi }], { state: 'open' }, { force: true })
    await secondLoad
    slowGate.resolve?.()
    await firstLoad

    expect(inbox.stateFor('host-a', '/repos/a')?.items.map((item) => item.title)).toEqual(['fresh'])
  })

  test('loadMore paginates only the named project, leaving others untouched', async () => {
    installStateRune()
    const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
    const { PrInboxStore } = await import('@solus/workspace-ui/contexts/prs/pr-inbox.store.svelte')
    const store = new PrsStore()
    const inbox = new PrInboxStore()

    const apiA = asHostApi({
      prList: async (_ctx: IpcContext, _filter: unknown, page = 1): Promise<PrListPage> =>
        page === 1
          ? { items: [pr(1)], page: 1, hasMore: true }
          : { items: [pr(2)], page: 2, hasMore: false },
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
      prGuideMetadata: async () => [],
    })
    const apiB = asHostApi({
      prList: async (): Promise<PrListPage> => ({ items: [pr(1)], page: 1, hasMore: false }),
      prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'b' }, checks: [] }),
      prGuideMetadata: async () => [],
    })

    await inbox.loadAll(store, [
      { serverId: 'host-a', projectRoot: '/repos/a', label: 'A', api: apiA, ctx: ctxFor('/repos/a') },
      { serverId: 'host-b', projectRoot: '/repos/b', label: 'B', api: apiB, ctx: ctxFor('/repos/b') },
    ], { state: 'open' })

    await inbox.loadMore(store, 'host-a', '/repos/a')

    expect(inbox.stateFor('host-a', '/repos/a')?.items.map((item) => item.number)).toEqual([1, 2])
    expect(inbox.stateFor('host-a', '/repos/a')?.hasMore).toBe(false)
    expect(inbox.stateFor('host-b', '/repos/b')?.items.map((item) => item.number)).toEqual([1])
  })
})

describe('qualified PR identity', () => {
  function project(serverId: string, projectRoot: string, items: PullRequestSummary[]): QualifiedProject {
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
