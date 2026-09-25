import { afterEach, describe, expect, test } from 'bun:test'
import type { PrFilter, PrListPage, PrProjectListing, PullRequest } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { IpcContext } from '@solus/contracts/types'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { PrProject } from '@solus/workspace-ui/contexts/prs/prs.store.svelte'
import {
  flattenQualifiedProjects,
  qualifiedPrKey,
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

function page(items: PullRequest[], hasMore = false): PrListPage {
  return { items, page: 1, hasMore }
}

/** A host that answers the every-project read from a page per project root. */
function hostServing(
  pages: Record<string, PrListPage | Error>,
  calls: { roots: string[] }[] = [],
): Pick<HostApi, 'prListProjects'> {
  return {
    prListProjects: async (_ctx: IpcContext, projectRoots: string[]): Promise<PrProjectListing[]> => {
      calls.push({ roots: projectRoots })
      return projectRoots.map((projectRoot) => {
        const answer = pages[projectRoot]
        return answer instanceof Error ? { projectRoot, error: answer.message } : { projectRoot, page: answer }
      })
    },
  }
}

function target(serverId: string, projectRoot: string, api: HostApi): PrProject {
  return { serverId, projectRoot, label: projectRoot, api, ctx: ctxFor(projectRoot) }
}

async function newStore() {
  installStateRune()
  const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
  return new PrsStore()
}

describe('PrsStore every-project read', () => {
  // WHY: the list used to ask for each project on its own and draw each answer
  // as it arrived, so rows came in project by project and the order moved under
  // the reader. One question per host means one answer to lay out per host.
  test('asks each host once for all of its projects', async () => {
    const store = await newStore()
    const callsA: { roots: string[] }[] = []
    const callsB: { roots: string[] }[] = []
    let perProjectReads = 0
    const apiA = asHostApi({
      ...hostServing({ '/repos/a': page([pr(1), pr(2)]), '/repos/c': page([pr(5)]) }, callsA),
      prList: async () => { perProjectReads++; return page([]) },
    })
    const apiB = asHostApi(hostServing({ '/repos/b': page([pr(1), pr(3)]) }, callsB))

    await store.listProjects([
      target('host-a', '/repos/a', apiA),
      target('host-b', '/repos/b', apiB),
      target('host-a', '/repos/c', apiA),
    ], { state: 'open' })

    expect(callsA).toEqual([{ roots: ['/repos/a', '/repos/c'] }])
    expect(callsB).toEqual([{ roots: ['/repos/b'] }])
    expect(perProjectReads).toBe(0)
    expect(store.at('host-a', '/repos/a')?.items.map((item) => item.number)).toEqual([1, 2])
    expect(store.at('host-a', '/repos/c')?.items.map((item) => item.number)).toEqual([5])
    expect(store.at('host-b', '/repos/b')?.items.map((item) => item.number)).toEqual([1, 3])
  })

  test('a project the host could not read keeps the other projects visible', async () => {
    const store = await newStore()
    const api = asHostApi(hostServing({ '/repos/ok': page([pr(1)]), '/repos/bad': new Error('host unreachable') }))

    await store.listProjects([target('h', '/repos/ok', api), target('h', '/repos/bad', api)], { state: 'open' })

    expect(store.at('h', '/repos/ok')?.items).toHaveLength(1)
    expect(store.at('h', '/repos/ok')?.error).toBeNull()
    expect(store.at('h', '/repos/bad')?.error?.message).toBe('host unreachable')
    expect(store.at('h', '/repos/bad')?.items).toEqual([])
  })

  test('a failed refresh keeps the rows every project already showed', async () => {
    const store = await newStore()
    let call = 0
    const api = asHostApi({
      prListProjects: async (_ctx: IpcContext, roots: string[]): Promise<PrProjectListing[]> => {
        if (++call === 1) return roots.map((projectRoot) => ({ projectRoot, page: page([pr(1)]) }))
        throw new Error('transient failure')
      },
      prInvalidate: async () => {},
    })
    const projects = [target('h', '/repos/a', api), target('h', '/repos/b', api)]

    await store.listProjects(projects, { state: 'open' })
    await store.listProjects(projects, { state: 'open' }, { force: true })

    for (const root of ['/repos/a', '/repos/b']) {
      expect(store.at('h', root)?.error?.message).toBe('transient failure')
      expect(store.at('h', root)?.items).toHaveLength(1)
      expect(store.at('h', root)?.loading).toBe(false)
    }
  })

  // WHY: My Workspace and any other folder without a remote can never answer.
  // Asking again on every refresh spends a host read for nothing, so the answer
  // is remembered until an explicit refresh.
  test('asks a project with no git remote once, and retries only on an explicit refresh', async () => {
    const store = await newStore()
    const calls: { roots: string[] }[] = []
    const api = asHostApi({
      ...hostServing({
        '/workspace': new Error('This folder has no recognizable git remote to review PRs from.'),
        '/repos/a': page([pr(1)]),
      }, calls),
      prInvalidate: async () => {},
    })
    const projects = [target('h', '/workspace', api), target('h', '/repos/a', api)]

    await store.listProjects(projects, { state: 'open' })
    expect(store.at('h', '/workspace')?.error?.kind).toBe('no-repository')

    await store.listProjects(projects, { state: 'open' })
    await store.listProjects(projects, { state: 'open' }, { force: true })

    expect(calls.map((call) => call.roots)).toEqual([
      ['/workspace', '/repos/a'],
      ['/repos/a'],
      ['/workspace', '/repos/a'],
    ])
  })

  // WHY: a refresh is a person asking for the code host again. The host shares
  // its answers between clients, so each project's host cache must be dropped
  // before the read, or the refresh would return the answer it meant to replace.
  test('a refresh forgets each project on the host before it reads', async () => {
    const store = await newStore()
    const order: string[] = []
    const api = asHostApi({
      prInvalidate: async (ctx: IpcContext) => { order.push(`forget ${ctx.session.projectPath}`) },
      prListProjects: async (_ctx: IpcContext, roots: string[]): Promise<PrProjectListing[]> => {
        order.push('read')
        return roots.map((projectRoot) => ({ projectRoot, page: page([]) }))
      },
    })

    await store.listProjects([target('h', '/repos/a', api), target('h', '/repos/b', api)], { state: 'open' }, { force: true })

    expect(order).toEqual(['forget /repos/a', 'forget /repos/b', 'read'])
  })

  test('a stale answer cannot land after a newer read has begun', async () => {
    const store = await newStore()
    const slowGate: { resolve: (() => void) | null } = { resolve: null }
    const slowApi = asHostApi({
      prListProjects: async (_ctx: IpcContext, roots: string[]): Promise<PrProjectListing[]> => {
        await new Promise<void>((resolve) => { slowGate.resolve = resolve })
        return roots.map((projectRoot) => ({ projectRoot, page: page([pr(999, { title: 'stale' })]) }))
      },
    })
    const fastApi = asHostApi({
      ...hostServing({ '/repos/a': page([pr(1, { title: 'fresh' })]) }),
      prInvalidate: async () => {},
    })

    const firstLoad = store.listProjects([target('h', '/repos/a', slowApi)], { state: 'open' })
    // A scope change starts a second, newer read before the first has answered.
    await store.listProjects([target('h', '/repos/a', fastApi)], { state: 'open' }, { force: true })
    slowGate.resolve?.()
    await firstLoad

    expect(store.at('h', '/repos/a')?.items.map((item) => item.title)).toEqual(['fresh'])
    expect(store.at('h', '/repos/a')?.loading).toBe(false)
  })

  // WHY: the first page came from the every-project read, but "load more" is
  // one project's own next page. It must continue from what that read filed.
  test('load more pages only the named project, after the shared first page', async () => {
    const store = await newStore()
    const apiA = asHostApi({
      ...hostServing({ '/repos/a': page([pr(1)], true) }),
      prList: async (_ctx: IpcContext, _filter: PrFilter, pageNumber = 1): Promise<PrListPage> =>
        ({ items: [pr(2)], page: pageNumber, hasMore: false }),
    })
    const apiB = asHostApi(hostServing({ '/repos/b': page([pr(1)]) }))

    await store.listProjects([target('host-a', '/repos/a', apiA), target('host-b', '/repos/b', apiB)], { state: 'open' })
    const projectA = store.at('host-a', '/repos/a')!
    await projectA.loadMore()

    expect(projectA.items.map((item) => item.number)).toEqual([1, 2])
    expect(projectA.hasMore).toBe(false)
    expect(store.at('host-b', '/repos/b')?.items.map((item) => item.number)).toEqual([1])
  })
})

describe('PrsStore one-project page read', () => {
  // WHY: the host adds the viewer's own and review-requested pull requests only
  // to this read. A one-project page that read the bare first page would lose
  // them again from its Authored and Review requested sections.
  test('reads one project through the same combined read as every project', async () => {
    const store = await newStore()
    const calls: { roots: string[] }[] = []
    let pageReads = 0
    const api = asHostApi({
      ...hostServing({ '/repos/a': page([pr(1), pr(40)]) }, calls),
      prList: async () => { pageReads++; return page([]) },
    })
    const project = store.get(api, 'h', ctxFor('/repos/a'))

    await store.readPage([project], { state: 'open' }, { memoryKey: 'one-project-test' })

    expect(calls).toEqual([{ roots: ['/repos/a'] }])
    expect(pageReads).toBe(0)
    expect(project.items.map((item) => item.number)).toEqual([1, 40])
    expect(project.loading).toBe(false)
  })
})

describe('PrsStore every-project reading flags', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => {}
    const promise = new Promise<T>((settle) => { resolve = settle })
    return { promise, resolve }
  }

  // WHY: the footer offers "Load more" and reads pagination off this flag. A
  // refresh raises `loading` on every project that has already read, so taking
  // pagination from that flag put a disabled "Loading…" footer under a list
  // with no further page every time the page refreshed or the scope changed.
  test('a refresh is reading, but it is not pagination', async () => {
    const store = await newStore()
    const refreshed = deferred<PrProjectListing[]>()
    let calls = 0
    const api = asHostApi({
      prListProjects: async (): Promise<PrProjectListing[]> =>
        ++calls === 1 ? [{ projectRoot: '/repos/a', page: page([pr(1)]) }] : refreshed.promise,
      prInvalidate: async () => {},
    })
    const projects = [target('h', '/repos/a', api)]

    await store.listProjects(projects, { state: 'open' })
    const refresh = store.listProjects(projects, { state: 'open' }, { force: true })

    expect(store.at('h', '/repos/a')?.loading).toBe(true)
    expect(store.at('h', '/repos/a')?.loadingMore).toBe(false)

    refreshed.resolve([{ projectRoot: '/repos/a', page: page([pr(1)]) }])
    await refresh
    expect(store.at('h', '/repos/a')?.loading).toBe(false)
    expect(store.at('h', '/repos/a')?.loadingMore).toBe(false)
  })

  test('appending a page is the one thing that reports as pagination', async () => {
    const store = await newStore()
    const second = deferred<PrListPage>()
    const api = asHostApi({
      ...hostServing({ '/repos/a': page([pr(1)], true) }),
      prList: async (): Promise<PrListPage> => second.promise,
    })

    await store.listProjects([target('h', '/repos/a', api)], { state: 'open' })

    const project = store.at('h', '/repos/a')!
    const more = project.loadMore()
    expect(project.loadingMore).toBe(true)

    second.resolve({ items: [pr(2)], page: 2, hasMore: false })
    await more
    expect(project.loadingMore).toBe(false)
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

