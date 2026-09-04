import { describe, expect, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }

const restPullRequest = {
  node_id: 'PR_1',
  number: 65,
  html_url: 'https://github.com/acme/app/pull/65',
  title: 'Make the pull request list fast',
  user: { login: 'sidhu', avatar_url: 'https://avatars.test/sidhu' },
  state: 'open',
  merged_at: null,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  draft: false,
  labels: [],
  base: { ref: 'main', sha: 'base-sha', repo: { full_name: 'acme/app' } },
  head: { ref: 'feature', sha: 'head-sha', repo: { full_name: 'acme/app', name: 'app', owner: { login: 'acme' } } },
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

interface PullListOptions {
  per_page: number
}

class ListProvider extends GitHubProvider {
  constructor(private readonly client: GitHubClient) {
    super()
  }

  protected override async clients(): Promise<GitHubClient[]> {
    return [this.client]
  }
}

function reviewStatusResponse(nodeIds: string[]) {
  return {
    repository: {
      pullRequests: {
        nodes: nodeIds.map((id) => ({
          id,
          reviewDecision: 'APPROVED' as const,
          reviews: { totalCount: 1 },
        })),
      },
    },
  }
}

describe('GitHub pull request list loading', () => {
  test('the first page starts rows and review states together and limits time-to-first-list work', async () => {
    // WHY: t3code has enough pull requests that waiting for 100 rows and then
    // starting review state made the first useful paint take multiple seconds.
    const rows = deferred<{ data: typeof restPullRequest[] }>()
    const reviewStates = deferred<ReturnType<typeof reviewStatusResponse>>()
    const started: string[] = []
    let listOptions: PullListOptions | undefined
    const client = {
      rest: {
        pulls: {
          list: (options: PullListOptions) => {
            listOptions = options
            started.push('rows')
            return rows.promise
          },
        },
        users: {
          getAuthenticated: async () => ({ data: { login: 'sidhu', avatar_url: '' } }),
        },
        repos: {
          get: async () => ({
            data: {
              permissions: { push: true },
              allow_merge_commit: true,
              allow_squash_merge: true,
              allow_rebase_merge: true,
            },
          }),
        },
      },
      graphql: (query: string) => {
        expect(query).toContain('PrListReviewStatuses')
        started.push('review-states')
        return reviewStates.promise
      },
      credential: { source: 'host', token: 'test-token' },
    } as unknown as GitHubClient
    const pagePromise = new ListProvider(client).listPullRequestsPage(repo, { state: 'all' }, 1)

    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['review-states', 'rows'])
    expect(listOptions?.per_page).toBe(30)

    rows.resolve({ data: [restPullRequest] })
    reviewStates.resolve(reviewStatusResponse(['PR_1']))
    const page = await pagePromise

    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.reviewStatus).toBe('approved')
  })

  test('a row that moved between parallel snapshots gets an exact-id status read', async () => {
    // WHY: parallel reads may straddle an update. Joining by node id and filling
    // gaps keeps speed from turning into a wrong review badge.
    const operations: string[] = []
    const client = {
      rest: {
        pulls: { list: async () => ({ data: [restPullRequest] }) },
        users: { getAuthenticated: async () => ({ data: { login: 'sidhu', avatar_url: '' } }) },
        repos: {
          get: async () => ({ data: { permissions: { push: true } } }),
        },
      },
      graphql: async (query: string) => {
        if (query.includes('PrListReviewStatuses')) {
          operations.push('parallel-page')
          return reviewStatusResponse([])
        }
        operations.push('exact-ids')
        return {
          nodes: [{
            id: 'PR_1',
            reviewDecision: 'CHANGES_REQUESTED' as const,
            reviews: { totalCount: 1 },
          }],
        }
      },
      credential: { source: 'host', token: 'test-token' },
    } as unknown as GitHubClient

    const page = await new ListProvider(client).listPullRequestsPage(repo, { state: 'open' }, 1)

    expect(operations).toEqual(['parallel-page', 'exact-ids'])
    expect(page.items[0]?.reviewStatus).toBe('changes-requested')
  })
})
