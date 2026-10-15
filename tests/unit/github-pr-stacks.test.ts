import { describe, expect, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }

class StubProvider extends GitHubProvider {
  constructor(private readonly client: GitHubClient) {
    super()
  }

  protected override async clients(): Promise<GitHubClient[]> {
    return [this.client]
  }
}

const repos = {
  get: async () => ({ data: { permissions: { push: true } } }),
  getBranchRules: async () => ({ data: [] }),
}
/** Access reads the base branch's rules; none apply here. */
const paginate = async () => []
const users = {
  getAuthenticated: async () => ({ data: { login: 'sidhu', avatar_url: '' } }),
}

/** GitHub answering one list search with a single row, and its repository. */
function listingClient(stack: object | null): GitHubClient {
  const row = {
    number: 2,
    url: 'https://github.com/acme/app/pull/2',
    title: 'Second layer',
    headRefOid: 'head-2',
    author: { login: 'sidhu', avatarUrl: '' },
    state: 'OPEN',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    isDraft: false,
    labels: { nodes: [] },
    additions: 1,
    deletions: 1,
    reviewRequests: { nodes: [] },
    assignees: { nodes: [] },
    body: '',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRefName: 'layer-2',
    changedFiles: 1,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    reviews: { totalCount: 0 },
    baseRepository: { nameWithOwner: 'acme/app' },
    headRepository: { nameWithOwner: 'acme/app', name: 'app', owner: { login: 'acme' } },
    ...stack,
  }
  return {
    rest: { users, repos, paginate },
    graphql: async () => ({
      p0: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [row] },
      p1: { nameWithOwner: 'acme/app', viewerPermission: 'WRITE', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: false, pullRequests: { totalCount: 1 } },
    }),
    credential: { source: 'host', token: 'test-token' },
  } as unknown as GitHubClient
}

function stacksClient(answers: Record<string, () => unknown>): GitHubClient {
  return {
    rest: {
      users,
      repos,
      paginate,
      request: async (route: string) => {
        const answer = answers[route]
        if (!answer) throw new Error(`unexpected request ${route}`)
        return { data: answer() }
      },
    },
    graphql: async () => ({}),
    credential: { source: 'host', token: 'test-token' },
  } as unknown as GitHubClient
}

const listedStack = {
  number: 4,
  url: 'https://api.github.com/repos/acme/app/stacks/4',
  base: { ref: 'main' },
  pull_requests: [
    { number: 65, head: { ref: 'layer-1' } },
    { number: 66, head: { ref: 'layer-2' } },
  ],
}

describe('GitHub stacked pull requests', () => {
  test('a listed row says where it sits in its stack without a request of its own', async () => {
    // WHY: the list badge must come from the facts query already on the wire,
    // so stacked pull requests cost the list nothing extra.
    const [page] = await new StubProvider(listingClient({
      stack: { number: 4, size: 3, baseRefName: 'main' },
      stackEntry: { position: 2 },
    })).listPullRequestPages([{ repo, page: 1, cursor: null }], { state: 'open' }, 'sidhu', false)

    expect(page?.page.items[0]?.stack).toEqual({ number: 4, position: 2, size: 3, base: 'main' })
  })

  test('a row GitHub places in no stack says so, rather than leaving it unknown', async () => {
    // WHY: absent means "not asked" and keeps an earlier answer on the client;
    // a row that left a stack must clear its badge.
    const [page] = await new StubProvider(listingClient({ stack: null, stackEntry: null }))
      .listPullRequestPages([{ repo, page: 1, cursor: null }], { state: 'open' }, 'sidhu', false)

    expect(page?.page.items[0]?.stack).toBeNull()
  })

  test('the stack is read whole, bottom to top, with each layer in its own state', async () => {
    const stack = await new StubProvider(stacksClient({
      'GET /repos/{owner}/{repo}/stacks': () => [listedStack],
      'GET /repos/{owner}/{repo}/stacks/{stack_number}': () => ({
        ...listedStack,
        html_url: 'https://github.com/acme/app/stacks/4',
        pull_requests: [
          { number: 65, title: 'First layer', state: 'closed', merged_at: '2026-08-03T00:00:00Z', head: { ref: 'layer-1' } },
          { number: 66, title: 'Second layer', state: 'open', draft: true, head: { ref: 'layer-2' } },
        ],
      }),
    })).getPullRequestStack(repo, 66)

    expect(stack).toEqual({
      number: 4,
      url: 'https://github.com/acme/app/stacks/4',
      base: 'main',
      layers: [
        { number: 65, title: 'First layer', headRef: 'layer-1', state: 'merged', draft: false },
        { number: 66, title: 'Second layer', headRef: 'layer-2', state: 'open', draft: true },
      ],
    })
  })

  test('a pull request in no stack, or in a repository without stacks, reads as null', async () => {
    // WHY: stacks are a preview; a repository without them must not show an
    // error on every pull request it opens.
    const empty = await new StubProvider(stacksClient({
      'GET /repos/{owner}/{repo}/stacks': () => [],
    })).getPullRequestStack(repo, 66)
    const unsupported = await new StubProvider(stacksClient({
      'GET /repos/{owner}/{repo}/stacks': () => {
        throw Object.assign(new Error('Not Found'), { status: 404 })
      },
    })).getPullRequestStack(repo, 66)

    expect(empty).toBeNull()
    expect(unsupported).toBeNull()
  })
})
