import { describe, expect, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'

/**
 * The two GitHub reads PR sync makes (docs/plans/pr-sync.md §3.2). Their cost
 * and their answer for a missing pull request are the point: a startup that
 * knew five wrong numbers used to spend five failing requests every time.
 */

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }

function row(number: number, updatedAt: string) {
  return {
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    title: `PR ${number}`,
    headRefOid: `head-${number}`,
    author: { login: 'sidhu', avatarUrl: '' },
    state: 'OPEN',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt,
    isDraft: false,
    labels: { nodes: [] },
    additions: 1,
    deletions: 1,
    reviewRequests: { nodes: [] },
    assignees: { nodes: [] },
    body: '',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRefName: `feature/${number}`,
    changedFiles: 1,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    reviews: { totalCount: 0 },
    baseRepository: { nameWithOwner: 'acme/app' },
    headRepository: { nameWithOwner: 'acme/app', name: 'app', owner: { login: 'acme' } },
  }
}

class SyncProvider extends GitHubProvider {
  constructor(private readonly client: GitHubClient) {
    super()
  }

  protected override async clients(): Promise<GitHubClient[]> {
    return [this.client]
  }
}

function client(graphql: (query: string, variables: { after?: string | null }) => Promise<unknown>) {
  return {
    rest: {
      users: { getAuthenticated: async () => ({ data: { login: 'sidhu', avatar_url: '' } }) },
      repos: { get: async () => ({ data: { permissions: { push: true } } }) },
    },
    graphql,
    credential: { source: 'host', token: 'sync-test-token' },
  } as unknown as GitHubClient
}

describe('PR sync reads', () => {
  test('numbers the repository does not have are one request and a null answer each', async () => {
    const queries: string[] = []
    const provider = new SyncProvider(client(async (query) => {
      queries.push(query)
      if (query.includes('PrSyncByNumber')) {
        // GitHub's answer when some aliases name no pull request.
        throw Object.assign(new Error('Could not resolve to a PullRequest'), {
          data: { repository: { pr7: row(7, '2026-08-02T00:00:00Z'), pr60: null, pr65: null } },
          errors: [
            { type: 'NOT_FOUND', path: ['repository', 'pr60'] },
            { type: 'NOT_FOUND', path: ['repository', 'pr65'] },
          ],
        })
      }
      return { nodes: [] }
    }))

    const answers = await provider.getPullRequests(repo, [7, 60, 65])

    expect(queries.filter((query) => query.includes('PrSyncByNumber'))).toHaveLength(1)
    expect(answers.get(7)?.title).toBe('PR 7')
    expect(answers.get(60)).toBeNull()
    expect(answers.get(65)).toBeNull()
  })

  test('a repository this credential cannot see is a failure, not a missing pull request', async () => {
    const provider = new SyncProvider(client(async () => {
      throw Object.assign(new Error('Could not resolve to a Repository'), {
        data: { repository: null },
        errors: [{ type: 'NOT_FOUND', path: ['repository'] }],
      })
    }))

    await expect(provider.getPullRequests(repo, [7])).rejects.toThrow()
  })

  test('the recent list stops at the first pull request not updated since the last tick', async () => {
    const pages: Array<string | null | undefined> = []
    const provider = new SyncProvider(client(async (_query, variables) => {
      pages.push(variables.after)
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: true, endCursor: 'next' },
            nodes: [row(3, '2026-08-05T00:00:00Z'), row(2, '2026-08-01T00:00:00Z')],
          },
        },
      }
    }))

    const recent = await provider.listRecentPullRequests(repo, '2026-08-02T00:00:00Z')

    expect(recent.map((pullRequest) => pullRequest.number)).toEqual([3])
    expect(pages).toEqual([null])
  })
})
