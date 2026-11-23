import { describe, expect, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'
import { PullRequestHead } from '@solus/contracts/repository-key'

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
    latestReviews: { totalCount: 0, nodes: [] },
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

function client(graphql: (query: string, variables: Partial<Record<string, string>>) => Promise<unknown>) {
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
          data: { r0: { p7: row(7, '2026-08-02T00:00:00Z'), p60: null, p65: null } },
          errors: [
            { type: 'NOT_FOUND', path: ['r0', 'p60'] },
            { type: 'NOT_FOUND', path: ['r0', 'p65'] },
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
        data: { r0: null },
        errors: [{ type: 'NOT_FOUND', path: ['r0'] }],
      })
    }))

    await expect(provider.getPullRequests(repo, [7])).rejects.toThrow()
  })

  test('the branches of one lookup are one query, and a branch with no pull request answers an empty list', async () => {
    // WHY: each lookup asked for the branch's ref and then, when the ref was
    // gone (as for every branch never pushed), searched by name: two queries.
    // t3code reads the base repository's pull requests by head name once and
    // keeps the exact head itself; so does this.
    const queries: string[] = []
    const provider = new SyncProvider(client(async (query) => {
      if (!query.includes('PrSyncByHead')) return { repository: null }
      queries.push(query)
      const feature = row(8, '2026-08-05T00:00:00Z')
      const older = { ...row(3, '2026-08-01T00:00:00Z'), headRefName: 'feature/8' }
      const fork = { ...row(5, '2026-08-03T00:00:00Z'), headRefName: 'feature/8', headRepository: { nameWithOwner: 'stranger/app', name: 'app', owner: { login: 'stranger' } } }
      return { r0: { h0: { nodes: [feature, fork, older] }, h1: { nodes: [] } } }
    }))
    const feature = new PullRequestHead(repo, 'feature/8')
    const idle = new PullRequestHead(repo, 'idle')

    const found = await provider.getPullRequestsByHead(repo, [feature, idle])

    expect(queries).toHaveLength(1)
    expect(queries[0]).not.toContain('PrSyncByHeadRef')
    // Another fork's branch of the same name is not this head's.
    expect(found.get(feature.key)?.map((pullRequest) => pullRequest.number)).toEqual([8, 3])
    expect(found.get(idle.key)).toEqual([])
  })
})
