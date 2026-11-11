import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { flushLogs, logFilePath } from '@solus/server/logger'
import type { PrFilter, PrListPage, PullRequest, RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubRateLimitedError } from '@solus/server/providers/github/rate-limit'
import { GitHubProvider } from '@solus/server/providers/github/provider'
import type { PriorityNumbers, PrPageRequest, Provider } from '@solus/server/providers/types'
import { PrIndex } from '@solus/server/prs/pr-index'

/**
 * The every-project pull request list. It used to cost a REST listing, two
 * GraphQL reads, and a REST search per project, against a search limit of
 * thirty a minute. Now one GitHub search answers up to a hundred repositories,
 * with the viewer's own and review-requested rows in the same document.
 */

const repoNamed = (name: string): RepoRef => ({ host: 'github.com', owner: 'acme', repo: name })

interface FakeRow {
  repo: string
  number: number
  author: string
  updatedAt: string
  rollup: string | null
  requested?: string[]
  assigned?: string[]
}

function gqlRow(row: FakeRow, nameOf: (repo: string) => string) {
  const name = nameOf(row.repo)
  return {
    number: row.number,
    url: `https://github.com/acme/${name}/pull/${row.number}`,
    title: `PR ${row.number}`,
    headRefOid: `head-${row.number}`,
    author: { login: row.author, avatarUrl: '' },
    state: 'OPEN',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: row.updatedAt,
    isDraft: false,
    labels: { nodes: [] },
    additions: 3,
    deletions: 1,
    reviewRequests: { nodes: (row.requested ?? []).map((login) => ({ requestedReviewer: { login } })) },
    assignees: { nodes: (row.assigned ?? []).map((login) => ({ login })) },
    body: '',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRefName: `feature/${row.number}`,
    changedFiles: 1,
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    latestReviews: { totalCount: 1, nodes: [] },
    baseRepository: { nameWithOwner: `acme/${name}` },
    headRepository: { nameWithOwner: `acme/${name}`, name, owner: { login: 'acme' } },
    autoMergeRequest: null,
    commits: { nodes: [{ commit: { statusCheckRollup: row.rollup ? { state: row.rollup } : null } }] },
  }
}

interface World {
  rows: FakeRow[]
  /** Repositories GitHub now names otherwise: old name → new name. */
  renamed?: Map<string, string>
  /** Repositories this credential cannot see. */
  hidden?: Set<string>
  hiddenError?: 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED'
  /** Pull requests the search index has not caught up with. */
  unindexed?: Set<number>
}

/** Every pull request of `count` repositories, `perRepo` each, newest first
 *  across them all. */
function rowsOf(names: string[], perRepo: number): FakeRow[] {
  let minute = 0
  const rows: FakeRow[] = []
  for (let index = 0; index < perRepo; index++) {
    for (const name of names) {
      minute++
      rows.push({
        repo: name,
        number: rows.length + 1,
        author: rows.length % 3 === 0 ? 'sidhu' : 'octocat',
        updatedAt: new Date(Date.UTC(2026, 8, 1) - minute * 60_000).toISOString().replace('.000', ''),
        rollup: 'SUCCESS',
      })
    }
  }
  return rows
}

/**
 * A GitHub that answers `PrListPages` documents from a list of pull requests:
 * searches by their qualifiers, repositories by name. Counts every request.
 */
function fakeGithub(world: World) {
  const calls: string[] = []
  const renamed = world.renamed ?? new Map<string, string>()
  const currentName = (repo: string) => renamed.get(repo) ?? repo
  const oldName = (name: string) => [...renamed].find(([, next]) => next === name)?.[0] ?? name
  const sorted = [...world.rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const search = (query: string, limit: number) => {
    const terms = query.split(' ')
    const repos = terms.filter((term) => term.startsWith('repo:')).map((term) => term.slice('repo:acme/'.length))
    // GitHub refuses a search that names a repository by an old name.
    if (repos.some((repo) => renamed.has(repo))) return { error: true as const }
    const valueOf = (prefix: string) => terms.find((term) => term.startsWith(prefix))?.slice(prefix.length)
    const before = valueOf('updated:<=')
    const author = valueOf('author:')
    const requested = valueOf('review-requested:')
    const assigned = valueOf('assignee:')
    const matches = sorted.filter((row) =>
      repos.includes(currentName(row.repo))
      && !world.unindexed?.has(row.number)
      && (!before || row.updatedAt <= before)
      && (!author || row.author === author)
      && (!requested || row.requested?.includes(requested))
      && (!assigned || row.assigned?.includes(assigned)))
    return {
      pageInfo: { hasNextPage: matches.length > limit, endCursor: null },
      nodes: matches.slice(0, limit).map((row) => gqlRow(row, currentName)),
    }
  }

  const graphql = async (query: string, variables: { [name: string]: string }) => {
    if (!query.includes('PrListPages')) {
      calls.push('graphql:other')
      return {}
    }
    calls.push('graphql:PrListPages')
    const data: { [alias: string]: object | null } = {}
    const errors: Array<{ type: string; path: string[] }> = []
    for (let index = 0; `p${index}q` in variables || `p${index}o` in variables; index++) {
      const alias = `p${index}`
      if (`${alias}q` in variables) {
        const limit = Number(new RegExp(`${alias}: search\\([^)]*first: (\\d+)`).exec(query)?.[1] ?? 100)
        const answer = search(variables[`${alias}q`], limit)
        if ('error' in answer) {
          data[alias] = null
          errors.push({ type: 'INVALID', path: [alias] })
        } else data[alias] = answer
        continue
      }
      const name = variables[`${alias}n`]
      if (world.hidden?.has(name)) {
        data[alias] = null
        errors.push({ type: world.hiddenError ?? 'NOT_FOUND', path: [alias] })
        continue
      }
      const own = sorted.filter((row) => row.repo === oldName(currentName(name)))
      const facts = {
        nameWithOwner: `acme/${currentName(name)}`,
        viewerPermission: 'WRITE',
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        autoMergeAllowed: true,
        viewerDefaultMergeMethod: 'SQUASH',
      }
      const field = query.slice(query.indexOf(`${alias}: repository`), query.indexOf('}', query.indexOf(`${alias}: repository`)) + 200)
      const isListing = new RegExp(`${alias}: repository\\([^)]*\\) \\{[^}]*pullRequests\\(first:`).test(query)
      if (isListing) {
        calls.push(`listing:${name}`)
        data[alias] = {
          ...facts,
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: own.slice(0, 100).map((row) => gqlRow(row, currentName)) },
        }
      } else {
        data[alias] = field.includes('totalCount') ? { ...facts, pullRequests: { totalCount: own.length } } : facts
      }
    }
    if (errors.length > 0) throw Object.assign(new Error('Some aliases failed'), { data, errors })
    return data
  }
  const restCall = (name: string) => async () => {
    calls.push(`rest:${name}`)
    throw new Error(`REST ${name} is not part of a list read`)
  }
  const client = {
    rest: {
      users: { getAuthenticated: restCall('users.getAuthenticated') },
      repos: { get: restCall('repos.get'), getBranchRules: restCall('repos.getBranchRules'), getBranchProtection: restCall('repos.getBranchProtection') },
      pulls: { list: restCall('pulls.list') },
      search: { issuesAndPullRequests: restCall('search.issuesAndPullRequests') },
      paginate: restCall('paginate'),
    },
    graphql,
    credential: { source: 'host', token: `list-${Math.random()}` },
  } as unknown as GitHubClient
  return { client, calls }
}

class OneClientProvider extends GitHubProvider {
  constructor(private readonly client: GitHubClient, private readonly fallbacks: GitHubClient[] = []) {
    super()
  }

  protected override async clients(): Promise<GitHubClient[]> {
    return [this.client, ...this.fallbacks]
  }
}

const count = (calls: string[], name: string) => calls.filter((call) => call === name).length
const restCalls = (calls: string[]) => calls.filter((call) => call.startsWith('rest:'))
const firstPages = (names: string[]): PrPageRequest[] => names.map((name) => ({ repo: repoNamed(name), page: 1, cursor: null }))

describe('one search lists many repositories', () => {
  test('three repositories cost one GraphQL request and no REST', async () => {
    const names = ['a', 'b', 'c']
    const { client, calls } = fakeGithub({ rows: rowsOf(names, 2) })

    const pages = await new OneClientProvider(client).listPullRequestPages(firstPages(names), { state: 'open' }, 'sidhu')

    expect(count(calls, 'graphql:PrListPages')).toBe(1)
    // No branch rules, no repository read, no REST listing or search.
    expect(restCalls(calls)).toEqual([])
    const [a] = pages
    expect(a?.items.map((item) => item.number)).toEqual([1, 4])
    expect(a).toMatchObject({ page: 1, hasMore: false })
    expect(a?.items[0]).toMatchObject({
      baseRepo: repoNamed('a'),
      reviewStatus: 'approved',
      checksState: 'passing',
      // The repository's own merge methods: the detail narrows them by branch.
      capabilities: { mergeMethods: ['squash'], defaultMergeMethod: 'squash' },
    })
  })

  // WHY: a full row costs about as much as a search, and the list search just
  // read most of these rows. Asking again made the first load twice the work.
  test('priority searches ask for numbers in one document, with no rows', async () => {
    const names = ['a', 'b', 'c']
    const rows = rowsOf(names, 2)
    rows[1].requested = ['sidhu']
    rows[2].assigned = ['sidhu']
    const { client, calls } = fakeGithub({ rows })
    const documents: string[] = []
    const original = client.graphql
    const read = spyOn(client, 'graphql').mockImplementation((query, variables) => {
      documents.push(query)
      return original(query, variables)
    })
    try {
      const [a, b, c] = await new OneClientProvider(client).listPriorityNumbers(names.map(repoNamed), 'open', 'sidhu')

      expect(count(calls, 'graphql:PrListPages')).toBe(1)
      expect(documents[0]).not.toContain('NeedsReviewFields')
      expect(a).toEqual({ authored: { numbers: [1, 4], hasMore: false }, needsReview: [] })
      expect(b?.needsReview).toEqual([2])
      expect(c?.needsReview).toEqual([3])
    } finally {
      read.mockRestore()
    }
  })

  test('closed pull requests search no review requests', async () => {
    const { client } = fakeGithub({ rows: rowsOf(['a'], 1) })

    const [answer] = await new OneClientProvider(client).listPriorityNumbers([repoNamed('a')], 'closed', 'sidhu')

    expect(answer?.needsReview).toBeNull()
  })

  test('a hundred and twenty repositories cost two GraphQL requests', async () => {
    const names = Array.from({ length: 120 }, (_unused, index) => `r${index}`)
    const { client, calls } = fakeGithub({ rows: rowsOf(names, 1) })

    const pages = await new OneClientProvider(client).listPullRequestPages(firstPages(names), { state: 'open' }, 'sidhu')

    expect(count(calls, 'graphql:PrListPages')).toBe(2)
    expect(restCalls(calls)).toEqual([])
    expect(pages.every((page) => page?.items.length === 1)).toBe(true)
  })

  test('the next page of several projects is one request, each from its own cursor', async () => {
    const names = ['a', 'b', 'c']
    const { client, calls } = fakeGithub({ rows: rowsOf(names, 50) })
    const provider = new OneClientProvider(client)
    const first = await provider.listPullRequestPages(firstPages(names), { state: 'open' }, 'sidhu')
    expect(first.every((page) => page?.hasMore && page.cursor)).toBe(true)
    calls.length = 0

    const next = await provider.listPullRequestPages(
      first.map((page, index) => ({ repo: repoNamed(names[index]), page: 2, cursor: page!.cursor! })),
      { state: 'open' },
      'sidhu',
      false,
    )

    expect(count(calls, 'graphql:PrListPages')).toBe(1)
    expect(restCalls(calls)).toEqual([])
    // Together the two pages hold every pull request once, newest first.
    names.forEach((name, index) => {
      const seen = [...first[index]!.items, ...next[index]!.items].map((item) => item.number)
      expect(new Set(seen).size).toBe(50)
      expect(next[index]!.page).toBe(2)
    })
  })

  test('search text is one GraphQL request and never REST search', async () => {
    const names = ['a', 'b']
    const { client, calls } = fakeGithub({ rows: rowsOf(names, 3) })

    const pages = await new OneClientProvider(client).listPullRequestPages(firstPages(names), { state: 'open', query: 'author:sidhu' }, 'sidhu')

    expect(count(calls, 'graphql:PrListPages')).toBe(1)
    expect(restCalls(calls)).toEqual([])
    expect(pages.flatMap((page) => page!.items.map((item) => item.author))).toEqual(['sidhu', 'sidhu'])
  })

  test('a repository the search index has not caught up with is read once from its own listing', async () => {
    const names = ['a', 'b']
    const rows = rowsOf(names, 2)
    const { client, calls } = fakeGithub({ rows, unindexed: new Set([rows[0].number]) })

    const pages = await new OneClientProvider(client).listPullRequestPages(firstPages(names), { state: 'open' }, 'sidhu')

    expect(count(calls, 'graphql:PrListPages')).toBe(2)
    expect(calls.filter((call) => call.startsWith('listing:'))).toEqual(['listing:a'])
    expect(pages[0]?.items.map((item) => item.number)).toContain(rows[0].number)
    expect(pages[1]?.items).toHaveLength(2)
  })

  test('a renamed repository is searched again by its new name, and that name is kept', async () => {
    const names = ['old-name', 'b']
    const rows = rowsOf(names, 1)
    const { client, calls } = fakeGithub({ rows, renamed: new Map([['old-name', 'new-name']]) })
    const provider = new OneClientProvider(client)

    const pages = await provider.listPullRequestPages(firstPages(names), { state: 'open' }, 'sidhu')
    expect(count(calls, 'graphql:PrListPages')).toBe(2)
    expect(pages[0]?.items).toHaveLength(1)
    // The row keeps the project's own repository name.
    expect(pages[0]?.items[0]?.baseRepo).toEqual(repoNamed('old-name'))

    calls.length = 0
    await provider.listPullRequestPages(firstPages(names), { state: 'open' }, 'sidhu')
    expect(count(calls, 'graphql:PrListPages')).toBe(1)
  })

  test('a hidden repository reports an access error when no credential can read it', async () => {
    const names = ['a', 'hidden-one', 'c']
    const { client } = fakeGithub({ rows: rowsOf(names, 1), hidden: new Set(['hidden-one']) })

    await expect(new OneClientProvider(client).listPullRequestPages(firstPages(names), { state: 'open' }, 'sidhu'))
      .rejects.toThrow('Some aliases failed')
  })

  for (const hiddenError of ['FORBIDDEN', 'NOT_FOUND'] as const) {
    test(`${hiddenError} in a partial answer falls back to gh for the complete list`, async () => {
      const names = ['allowed', 'org-restricted']
      const rows = rowsOf(names, 1)
      const account = fakeGithub({ rows, hidden: new Set(['org-restricted']), hiddenError })
      account.client.credential.source = 'account'
      const gh = fakeGithub({ rows })
      gh.client.credential.source = 'gh-cli'

      const pages = await new OneClientProvider(account.client, [gh.client])
        .listPullRequestPages(firstPages(names), undefined, 'sidhu')

      expect(pages.map((page) => page?.items.map((item) => item.number))).toEqual([[1], [2]])
      expect(count(gh.calls, 'graphql:PrListPages')).toBe(1)
    })
  }

  test('an access failure in one document still falls back when another document succeeds', async () => {
    const names = Array.from({ length: 101 }, (_, index) => `fallback-${index}`)
    const rows = rowsOf(names, 1)
    const account = fakeGithub({ rows, hidden: new Set([names[100]]), hiddenError: 'FORBIDDEN' })
    const gh = fakeGithub({ rows })
    gh.client.credential.source = 'gh-cli'

    const pages = await new OneClientProvider(account.client, [gh.client])
      .listPullRequestPages(firstPages(names), undefined, 'sidhu')

    expect(pages.every((page) => page?.items.length === 1)).toBe(true)
    expect(count(account.calls, 'graphql:PrListPages')).toBe(2)
    expect(count(gh.calls, 'graphql:PrListPages')).toBe(2)
  })

  test('an access failure on the search retry reaches the next credential', async () => {
    const names = ['retry-allowed', 'retry-restricted']
    const rows = rowsOf(names, 1)
    const account = fakeGithub({ rows, unindexed: new Set([2]) })
    const read = account.client.graphql
    let calls = 0
    account.client.graphql = async (query, variables) => {
      if (++calls === 2) throw Object.assign(new Error('Organization blocks this app'), {
        data: { p0: null }, errors: [{ type: 'FORBIDDEN', path: ['p0'] }],
      })
      return read(query, variables)
    }
    const gh = fakeGithub({ rows })
    gh.client.credential.source = 'gh-cli'

    const pages = await new OneClientProvider(account.client, [gh.client])
      .listPullRequestPages(firstPages(names), undefined, 'sidhu')

    expect(calls).toBe(2)
    expect(pages.map((page) => page?.items.map((item) => item.number))).toEqual([[1], [2]])
    expect(count(gh.calls, 'graphql:PrListPages')).toBe(1)
  })

  test('a partial rate-limit error stops the read without spending the next credential', async () => {
    const names = ['limited']
    const rows = rowsOf(names, 1)
    const account = fakeGithub({ rows, hidden: new Set(names), hiddenError: 'RATE_LIMITED' })
    const gh = fakeGithub({ rows })

    await expect(new OneClientProvider(account.client, [gh.client])
      .listPullRequestPages(firstPages(names), undefined, 'sidhu')).rejects.toBeInstanceOf(GitHubRateLimitedError)
    expect(gh.calls).toEqual([])
  })

  test('rows carry the head commit\'s combined check state', async () => {
    const rows = rowsOf(['a'], 4)
    rows[0].rollup = 'FAILURE'
    rows[1].rollup = 'PENDING'
    rows[2].rollup = 'ERROR'
    rows[3].rollup = null
    const { client } = fakeGithub({ rows })

    const [page] = await new OneClientProvider(client).listPullRequestPages(firstPages(['a']), { state: 'open' }, 'sidhu')

    expect(page?.items.map((item) => item.checksState)).toEqual(['failing', 'pending', 'failing', 'none'])
  })

  test('a branch lookup reads the repository\'s listing by head branch, not REST', async () => {
    const rows = rowsOf(['a'], 1)
    const { client, calls } = fakeGithub({ rows })
    let asked = ''
    const graphql = client.graphql as unknown as (query: string, variables: { [name: string]: string }) => Promise<object>
    ;(client as unknown as { graphql: typeof graphql }).graphql = async (query, variables) => {
      asked = query
      expect(variables.p0h).toBe('feature/1')
      return graphql(query, variables)
    }

    const [page] = await new OneClientProvider(client).listPullRequestPages(firstPages(['a']), { state: 'all', head: 'feature/1' }, 'sidhu')

    expect(asked).toContain('headRefName')
    expect(restCalls(calls)).toEqual([])
    expect(page?.items.map((item) => item.headRef)).toEqual(['feature/1'])
  })
})

/** A provider whose reads are counted and scripted per repository. */
function batchingProvider(answer: (repo: RepoRef) => PrListPage | null, priority: (repo: RepoRef) => PriorityNumbers | null = () => null) {
  const calls = { batches: [] as string[][], alone: [] as string[], needsReview: 0, priority: [] as string[][], byNumber: [] as number[][] }
  const review = {
    listPullRequestPages: async (requests: PrPageRequest[], filter: PrFilter | undefined) => {
      if (requests.length === 1 && filter?.query) {
        calls.alone.push(`${requests[0].repo.repo} ${filter.query}`)
        return [{ items: [], page: 1, hasMore: false }]
      }
      calls.batches.push(requests.map((request) => request.repo.repo))
      return requests.map((request) => answer(request.repo))
    },
    listPriorityNumbers: async (repos: RepoRef[]) => {
      calls.priority.push(repos.map((repo) => repo.repo))
      return repos.map(priority)
    },
    getPullRequests: async (_repo: RepoRef, numbers: number[]) => {
      calls.byNumber.push(numbers)
      return new Map(numbers.map((number) => [number, { number, updatedAt: `2026-09-0${number}` } as PullRequest]))
    },
    listPullRequestsNeedingReview: async () => {
      calls.needsReview++
      return []
    },
  }
  return { provider: { id: 'github', review } as unknown as Provider, calls }
}

function repositoryPage(...numbers: number[]): PrListPage {
  return { items: numbers.map((number) => ({ number, updatedAt: `2026-09-0${number}` }) as PullRequest), page: 1, hasMore: false }
}

describe('the index over a many-repository read', () => {
  test('many repositories cost one read, and a second read inside the lifetime costs none', async () => {
    const index = new PrIndex()
    const { provider, calls } = batchingProvider((repo) => repositoryPage(repo.repo === 'a' ? 1 : 2))

    const reads = await index.listPages(provider, firstPages(['a', 'b']), 'sidhu', { state: 'open' })
    expect((await reads.get('github.com/acme/a'))?.items.map((item) => item.number)).toEqual([1])
    expect((await reads.get('github.com/acme/b'))?.items.map((item) => item.number)).toEqual([2])

    // The read filed its answers where the single-project reads look.
    expect((await index.list(repoNamed('a'), provider, 'sidhu', { state: 'open' }, 1)).items[0]?.number).toBe(1)
    await index.listPages(provider, firstPages(['a', 'b']), 'sidhu', { state: 'open' })

    expect(calls.batches).toEqual([['a', 'b']])
    expect(calls.alone).toEqual([])
  })

  test('a repository the read could not see is left to its own read', async () => {
    // WHY: the project then reads with the credential, and the viewer, that
    // can see it, so its review attention names the right account.
    const index = new PrIndex()
    const { provider } = batchingProvider((repo) => repo.repo === 'hidden' ? null : repositoryPage(1))

    const reads = await index.listPages(provider, firstPages(['a', 'hidden']), 'sidhu', { state: 'open' })

    expect([...reads.keys()]).toEqual(['github.com/acme/a'])
  })

  test('a later page with no cursor asks for nothing', async () => {
    const index = new PrIndex()
    const { provider, calls } = batchingProvider(() => repositoryPage(1))

    const reads = await index.listPages(provider, [{ repo: repoNamed('a'), page: 2, cursor: null }], 'sidhu', { state: 'open' })

    expect(await reads.get('github.com/acme/a')).toEqual({ items: [], page: 2, hasMore: false })
    expect(calls.batches).toEqual([])
  })
})

describe('the index over a priority read', () => {
  const priorityOf = async (index: PrIndex, provider: Provider, names: string[]) => {
    const reads = index.listPriority(provider, names.map(repoNamed), 'sidhu', 'open')
    const read = reads.get(`github.com/acme/${names[0]}`)!
    return { authored: await read.authored, needsReview: await read.needsReview }
  }

  // WHY: this is the saving. A person whose pull requests are all on the page
  // pays for the searches and for no row.
  test('a row the first page holds is not read again', async () => {
    const index = new PrIndex()
    const { provider, calls } = batchingProvider(
      () => repositoryPage(1, 2),
      () => ({ authored: { numbers: [1, 2], hasMore: false }, needsReview: [] }),
    )
    await index.listPages(provider, firstPages(['a']), 'sidhu', { state: 'open' })

    const { authored } = await priorityOf(index, provider, ['a'])

    expect(authored.items.map((row) => row.number)).toEqual([1, 2])
    expect(calls.byNumber).toEqual([])
    expect(calls.batches).toEqual([['a']])
  })

  test('a number past the first page is read, in one request for its repository', async () => {
    const index = new PrIndex()
    const { provider, calls } = batchingProvider(
      () => repositoryPage(1),
      () => ({ authored: { numbers: [7, 1], hasMore: true }, needsReview: [1, 8, 8] }),
    )
    await index.listPages(provider, firstPages(['a']), 'sidhu', { state: 'open' })

    const { authored, needsReview } = await priorityOf(index, provider, ['a'])

    expect(authored.items.map((row) => row.number)).toEqual([7, 1])
    expect(authored.hasMore).toBe(true)
    expect(needsReview?.map((row) => row.number)).toEqual([8, 1])
    expect(calls.byNumber.flat().sort()).toEqual([7, 8])
  })

  test('many repositories name their numbers in one read, and a second read costs none', async () => {
    const index = new PrIndex()
    const { provider, calls } = batchingProvider(
      () => repositoryPage(1),
      () => ({ authored: { numbers: [], hasMore: false }, needsReview: [] }),
    )
    await index.listPages(provider, firstPages(['a', 'b']), 'sidhu', { state: 'open' })

    await priorityOf(index, provider, ['a', 'b'])
    await priorityOf(index, provider, ['a', 'b'])

    expect(calls.priority).toEqual([['a', 'b']])
  })

  test('a part the read could not answer is read alone', async () => {
    const index = new PrIndex()
    const { provider, calls } = batchingProvider(() => repositoryPage(1))
    await index.listPages(provider, firstPages(['a']), 'sidhu', { state: 'open' })

    await priorityOf(index, provider, ['a'])

    expect(calls.alone).toEqual(['a author:sidhu'])
    expect(calls.needsReview).toBe(1)
  })
})

describe('the pull request detail read', () => {
  test('changed-file sizes are read without the patches the diff reads', async () => {
    const queries: Array<{ cursor: string | null }> = []
    const client = {
      rest: {},
      graphql: async (query: string, variables: { cursor: string | null }) => {
        expect(query).toContain('PrFileStats')
        queries.push({ cursor: variables.cursor })
        const firstPage = variables.cursor === null
        return {
          repository: {
            pullRequest: {
              files: {
                pageInfo: { hasNextPage: firstPage, endCursor: firstPage ? 'next' : null },
                nodes: firstPage
                  ? [{ path: 'a.ts', additions: 2, deletions: 1, changeType: 'ADDED' }]
                  : [{ path: 'b.ts', additions: 0, deletions: 4, changeType: 'DELETED' }, { path: 'c.ts', additions: 1, deletions: 1, changeType: 'COPIED' }],
              },
            },
          },
        }
      },
      credential: { source: 'host', token: 'file-stats-token' },
    } as unknown as GitHubClient

    const stats = await new OneClientProvider(client).listPullRequestFileStats(repoNamed('app'), 9)

    expect(queries).toEqual([{ cursor: null }, { cursor: 'next' }])
    expect(stats).toEqual([
      { path: 'a.ts', additions: 2, deletions: 1, status: 'A' },
      { path: 'b.ts', additions: 0, deletions: 4, status: 'D' },
      { path: 'c.ts', additions: 1, deletions: 1, status: 'M' },
    ])
  })
})


describe('large repository request recovery', () => {
  test.each([
    { status: 502 }, { status: 503 }, { status: 504 },
    { errors: [{ type: 'MAX_NODE_LIMIT_EXCEEDED' }] },
    { errors: [{ type: 'RESOURCE_LIMITS_EXCEEDED' }] },
    { errors: [{ type: 'TIMEOUT' }] },
  ])('an overloaded read (%j) retries with fewer rows and keeps the next-page cursor', async (failure) => {
    const { client } = fakeGithub({ rows: rowsOf(['large'], 80) })
    const original = client.graphql
    const read = spyOn(client, 'graphql').mockRejectedValueOnce(Object.assign(new Error('GitHub could not complete the query'), failure))
    read.mockImplementation(original)
    try {
      const [page] = await new OneClientProvider(client).listPullRequestPages(firstPages(['large']), { state: 'open' }, 'sidhu')
      expect(page?.items).toHaveLength(50)
      expect(page?.hasMore).toBe(true)
      expect(page?.cursor).toBe(`search:${page?.items.at(-1)?.updatedAt}`)
      expect(read.mock.calls[0][0]).toContain('first: 100')
      expect(read.mock.calls[1][0]).toContain('first: 50')
    } finally {
      read.mockRestore()
    }
  })

  test('two gateway failures reduce the page from 100 to 50 to 25 before splitting', async () => {
    const { client } = fakeGithub({ rows: rowsOf(['large'], 80) })
    const original = client.graphql
    const failure = Object.assign(new Error('Bad Gateway'), { status: 502 })
    const read = spyOn(client, 'graphql')
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
    read.mockImplementation(original)
    try {
      const [page] = await new OneClientProvider(client).listPullRequestPages(firstPages(['large']), { state: 'open' }, 'sidhu')
      expect(read.mock.calls.map(([query]) => Number(/first: (\d+)/.exec(query)?.[1]))).toEqual([100, 50, 25])
      expect(page?.items).toHaveLength(25)
      expect(page?.hasMore).toBe(true)
      expect(page?.cursor).toBe(`search:${page?.items.at(-1)?.updatedAt}`)
    } finally {
      read.mockRestore()
    }
  })

  test('an overloaded document splits into independent reads with correct alias ownership', async () => {
    const { client } = fakeGithub({ rows: rowsOf(['large'], 3) })
    const original = client.graphql
    const documents: string[] = []
    const read = spyOn(client, 'graphql').mockImplementation(async (query, variables) => {
      documents.push(query)
      if ((query.match(/p\d+: /g) ?? []).length > 1) {
        throw Object.assign(new Error('Bad Gateway'), { status: 502 })
      }
      // A facts-only document must not contain an unused row fragment.
      if (!query.includes('search(')) expect(query).not.toContain('fragment NeedsReviewFields')
      return original(query, variables)
    })
    try {
      const [page] = await new OneClientProvider(client).listPullRequestPages(firstPages(['large']), { state: 'open' }, 'sidhu')
      expect(page?.items.map((row) => row.number)).toEqual([1, 2, 3])
      expect(documents.length).toBeLessThanOrEqual(12)
    } finally {
      read.mockRestore()
    }
  })

  test('a persistent gateway failure stops after a single-field retry', async () => {
    const { client } = fakeGithub({ rows: [] })
    const failure = Object.assign(new Error('Bad Gateway'), { status: 502 })
    const read = spyOn(client, 'graphql').mockRejectedValue(failure)
    try {
      await expect(new OneClientProvider(client).listPullRequestPages(firstPages(['large']), { state: 'open' }, 'sidhu')).rejects.toThrow('Bad Gateway')
      expect(read).toHaveBeenCalledTimes(4)
    } finally {
      read.mockRestore()
    }
  })
})


test('PR list logs connect a failed large read to its successful smaller retry', async () => {
  const { client } = fakeGithub({ rows: rowsOf(['diagnostic-repo'], 40) })
  const original = client.graphql
  const githubRequestId = 'pr-list-gateway-diagnostic'
  const read = spyOn(client, 'graphql').mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), {
    status: 502,
    response: { headers: { 'x-github-request-id': githubRequestId, 'content-type': 'text/html' } },
  }))
  read.mockImplementation(original)
  try {
    await new OneClientProvider(client).listPullRequestPages(firstPages(['diagnostic-repo']), { state: 'open', query: 'private-search-text' }, 'sidhu')
    flushLogs()
    const entrySchema = z.object({
      msg: z.string().optional(),
      readId: z.string().optional(),
      requestId: z.string().optional(),
      parentRequestId: z.string().nullable().optional(),
      githubRequestId: z.string().nullable().optional(),
      status: z.number().nullable().optional(),
      rowsPerPage: z.number().optional(),
      durationMs: z.number().optional(),
      queryBytes: z.number().optional(),
      repositories: z.array(z.string()).optional(),
    })
    const lines = readFileSync(logFilePath(), 'utf8').trim().split('\n')
    const entries = lines.map((line) => entrySchema.parse(JSON.parse(line)))
    const failed = entries.find((entry) => entry.githubRequestId === githubRequestId)
    expect(failed).toMatchObject({
      msg: 'github_pr_list_request_failed', status: 502, rowsPerPage: 100,
      repositories: ['acme/diagnostic-repo'], durationMs: expect.any(Number), queryBytes: expect.any(Number),
    })
    const attempts = entries.filter((entry) => entry.readId === failed?.readId)
    expect(attempts.map((entry) => entry.msg)).toEqual([
      'github_pr_list_request_started', 'github_pr_list_request_failed',
      'github_pr_list_request_reduced', 'github_pr_list_request_started', 'github_pr_list_request_completed',
    ])
    expect(attempts.at(-1)).toMatchObject({ rowsPerPage: 50, parentRequestId: failed?.requestId })
    const diagnostics = lines.filter((line) => line.includes(failed!.readId!)).join('\n')
    expect(diagnostics).not.toContain('private-search-text')
    expect(diagnostics).not.toContain(client.credential.token)
  } finally {
    read.mockRestore()
  }
})
