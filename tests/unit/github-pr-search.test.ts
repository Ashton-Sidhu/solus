import { describe, expect, test } from 'bun:test'
import type { PrFilter, PrListPage, RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import type { PrPageRequest, Provider } from '@solus/server/providers/types'
import { GitHubProvider } from '@solus/server/providers/github/provider'
import { pullRequestSearchQuery } from '@solus/server/providers/github/pull-request-search'
import { PrIndex } from '@solus/server/prs/pr-index'

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }

class SearchProvider extends GitHubProvider {
  constructor(private readonly client: GitHubClient) {
    super()
  }

  protected override async clients(): Promise<GitHubClient[]> {
    return [this.client]
  }
}

function searchRow(number: number) {
  return {
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    title: `Search hit ${number}`,
    headRefOid: `head-${number}`,
    author: { login: 'sidhu', avatarUrl: '' },
    state: 'OPEN' as const,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    isDraft: false,
    labels: { nodes: [{ name: 'bug', color: 'f00' }] },
    additions: 3,
    deletions: 1,
    reviewRequests: { nodes: [] },
    assignees: { nodes: [] },
    body: '',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRefName: `feature/${number}`,
    changedFiles: 1,
    mergeable: 'MERGEABLE' as const,
    reviewDecision: 'APPROVED' as const,
    reviews: { totalCount: 1 },
    baseRepository: { nameWithOwner: 'acme/app' },
    headRepository: { nameWithOwner: 'acme/app', name: 'app', owner: { login: 'acme' } },
  }
}

describe('GitHub pull request search', () => {
  test('the list state becomes a qualifier; closed includes merged and all has none', () => {
    // WHY: the search is the listing, so it must answer the state the list is
    // on — otherwise a search under Open finds merged work.
    expect(pullRequestSearchQuery(['acme/app'], 'open', { query: ' label:"bug" login ' }))
      .toBe('is:pr is:open repo:acme/app sort:updated-desc label:"bug" login')
    expect(pullRequestSearchQuery(['acme/app', 'acme/site'], 'closed', { query: 'x' }))
      .toBe('is:pr is:closed repo:acme/app repo:acme/site sort:updated-desc x')
    expect(pullRequestSearchQuery(['acme/app'], 'all', { before: '2026-09-01T00:00:00Z' }))
      .toBe('is:pr repo:acme/app sort:updated-desc updated:<=2026-09-01T00:00:00Z')
  })

  test('a typed query is one GraphQL search, answered in the listing\'s shape and in search order', async () => {
    // WHY: every surface draws a pull request from one shape; a search result
    // missing branches or heads would break the row and the detail panel.
    const searched: string[] = []
    let restCalls = 0
    const rest = () => { restCalls++; throw new Error('not a list read') }
    const client = {
      rest: { search: { issuesAndPullRequests: rest }, pulls: { list: rest }, users: { getAuthenticated: rest }, repos: { get: rest } },
      graphql: async (_query: string, variables: { [name: string]: string }) => {
        searched.push(variables.p0q)
        return {
          p0: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [searchRow(9), { }, searchRow(4)] },
          p1: { nameWithOwner: 'acme/app', viewerPermission: 'WRITE', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: false },
        }
      },
      credential: { source: 'host', token: 'test-token' },
    } as unknown as GitHubClient

    const [found] = await new SearchProvider(client).listPullRequestPages(
      [{ repo, page: 1, cursor: null }], { state: 'open', query: 'label:"bug"' }, 'sidhu', false)

    expect(restCalls).toBe(0)
    expect(searched).toEqual(['is:pr is:open repo:acme/app sort:updated-desc label:"bug"'])
    expect(found?.page.items.map((item) => [item.number, item.headRef, item.baseRepo.repo, item.reviewStatus])).toEqual([
      [9, 'feature/9', 'app', 'approved'],
      [4, 'feature/4', 'app', 'approved'],
    ])
    expect(found?.page.hasMore).toBe(false)
  })

  test('the index caches a search apart from the listing it replaces', async () => {
    // WHY: clearing the search must bring back the listing, not the last
    // search's answer filed under the same key.
    const asked: (string | undefined)[] = []
    const provider = {
      review: {
        listPullRequestPages: async (requests: PrPageRequest[], filter?: PrFilter) => {
          asked.push(filter?.query)
          return requests.map(() => ({ page: { items: [], page: 1, hasMore: false } satisfies PrListPage, authored: null, needsReview: null }))
        },
      },
    } as unknown as Provider
    const index = new PrIndex()
    await index.list(repo, provider, 'sidhu', { state: 'open' }, 1)
    await index.list(repo, provider, 'sidhu', { state: 'open', query: 'login' }, 1)
    await index.list(repo, provider, 'sidhu', { state: 'open' }, 1)
    expect(asked).toEqual([undefined, 'login'])
  })
})
