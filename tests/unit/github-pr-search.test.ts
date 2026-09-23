import { describe, expect, test } from 'bun:test'
import type { PrListPage, RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import type { Provider } from '@solus/server/providers/types'
import { GitHubProvider, pullRequestSearchTerms } from '@solus/server/providers/github/provider'
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
    // WHY: the search replaces the listing for one page, so it must answer the
    // same state the list is on — otherwise a search under Open finds merged work.
    expect(pullRequestSearchTerms(repo, 'open', ' label:"bug" login ')).toBe('repo:acme/app is:pr is:open label:"bug" login')
    expect(pullRequestSearchTerms(repo, 'closed', 'x')).toBe('repo:acme/app is:pr is:closed x')
    expect(pullRequestSearchTerms(repo, 'all', 'x')).toBe('repo:acme/app is:pr x')
  })

  test('a typed query reads GitHub search and answers in the listing\'s shape, in search order', async () => {
    // WHY: every surface draws a pull request from one shape; a search result
    // missing branches or heads would break the row and the detail panel.
    let searched: { q: string; per_page: number; page: number } | undefined
    let listed = false
    const client = {
      rest: {
        search: {
          issuesAndPullRequests: async (options: { q: string; per_page: number; page: number }) => {
            searched = options
            return {
              data: {
                total_count: 2,
                items: [
                  { node_id: 'PR_9', pull_request: {} },
                  { node_id: 'ISSUE_1' },
                  { node_id: 'PR_4', pull_request: {} },
                ],
              },
            }
          },
        },
        pulls: { list: async () => { listed = true; return { data: [] } } },
        users: { getAuthenticated: async () => ({ data: { login: 'sidhu', avatar_url: '' } }) },
        repos: {
          get: async () => ({ data: { full_name: 'acme/app', permissions: { push: true } } }),
        },
      },
      graphql: async (_query: string, variables: { ids: string[] }) => ({
        nodes: variables.ids.map((id) => searchRow(Number(id.replace('PR_', '')))),
      }),
      credential: { source: 'host', token: 'test-token' },
    } as unknown as GitHubClient

    const page = await new SearchProvider(client).listPullRequestsPage(repo, { state: 'open', query: 'label:"bug"' }, 1)

    expect(listed).toBe(false)
    expect(searched?.q).toBe('repo:acme/app is:pr is:open label:"bug"')
    expect(page.items.map((item) => [item.number, item.headRef, item.baseRepo.repo, item.reviewStatus])).toEqual([
      [9, 'feature/9', 'app', 'approved'],
      [4, 'feature/4', 'app', 'approved'],
    ])
    expect(page.hasMore).toBe(false)
  })

  test('the index caches a search apart from the listing it replaces', async () => {
    // WHY: clearing the search must bring back the listing, not the last
    // search's answer filed under the same key.
    const asked: (string | undefined)[] = []
    const provider = {
      review: {
        listPullRequestsPage: async (_repo: RepoRef, filter?: { query?: string }): Promise<PrListPage> => {
          asked.push(filter?.query)
          return { items: [], page: 1, hasMore: false }
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
