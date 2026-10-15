import { describe, expect, test } from 'bun:test'
import type { PullRequest, RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'
import { MAX_PULL_REQUEST_DIFF_BYTES } from '@solus/server/providers/github/pull-request-diff'
import type { Provider } from '@solus/server/providers/types'
import { PrIndex } from '@solus/server/prs/pr-index'
import { githubPullRequestDetailAnswer, type DetailAnswerOptions } from './helpers/github-pull-request-detail'

/**
 * What one pull request page costs GitHub.
 *
 * Every request leaves for a host whose limits are low, and each sequential
 * hop is latency the reader waits through. These tests count what a fake
 * GitHub was asked, so a change that adds a request or a hop fails here.
 */

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }

interface Script {
  detail?: () => unknown
  commitsPage?: () => unknown
  diff?: () => Promise<string>
  files?: (page: number) => { data: Array<{ filename: string; status: string; patch?: string }>; headers: { link?: string } }
  content?: (ref: string, path: string) => Promise<string>
}

interface CountingClient extends GitHubClient {
  calls: string[]
}

function countingClient(script: Script = {}): CountingClient {
  const calls: string[] = []
  const rest = {
    pulls: {
      get: async (params: { mediaType?: { format?: string } }) => {
        calls.push(params.mediaType?.format === 'diff' ? 'rest:pulls.get.diff' : 'rest:pulls.get')
        return { data: await (script.diff ?? (async () => 'diff --git a/a.ts b/a.ts\n'))() }
      },
      listFiles: async (params: { page: number }) => {
        calls.push(`rest:pulls.listFiles:${params.page}`)
        return (script.files ?? (() => ({ data: [], headers: {} })))(params.page)
      },
    },
    repos: {
      compareCommitsWithBasehead: async () => {
        calls.push('rest:repos.compare')
        return { data: { merge_base_commit: { sha: 'b'.repeat(40) }, commits: [{ sha: 'head-sha' }] } }
      },
      getContent: async (params: { path: string; ref: string }) => {
        calls.push(`rest:repos.getContent:${params.ref}`)
        const text = await (script.content ?? (async (ref: string, path: string) => `${ref}:${path}`))(params.ref, params.path)
        return { data: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } }
      },
      getBranchRules: async () => {
        calls.push('rest:repos.getBranchRules')
        return { data: [] }
      },
    },
  }
  const graphql = async (query: string) => {
    const operation = /query (\w+)/.exec(query)?.[1] ?? 'anonymous'
    calls.push(`graphql:${operation}`)
    if (operation === 'PullRequestDetail') return (script.detail ?? (() => githubPullRequestDetailAnswer()))()
    if (operation === 'PullRequestCommits') return script.commitsPage?.()
    throw new Error(`Unexpected query ${operation}`)
  }
  return {
    rest,
    graphql,
    credential: { source: 'host', token: `token-${Math.random()}` },
    calls,
  } as unknown as CountingClient
}

class CountingProvider extends GitHubProvider {
  constructor(private readonly chain: GitHubClient[]) {
    super()
  }

  protected override async clients(): Promise<GitHubClient[]> {
    return this.chain
  }
}

function detailWith(options: DetailAnswerOptions): () => unknown {
  return () => githubPullRequestDetailAnswer(options)
}

describe('GitHub pull request detail', () => {
  test('a cold pull request page costs one GraphQL request and no REST', async () => {
    // WHY: opening a pull request used to cost `pulls.get`, `GET /user`,
    // `repos.get`, a merge-methods query, the branch rules and protection, the
    // commits and the reviews: eight requests in four hops. One query answers
    // the page, and its overview reuses that answer.
    const client = countingClient()
    const provider = new CountingProvider([client])
    const pullRequest = new PrIndex().pullRequest(repo, { review: provider } as unknown as Provider, 65)

    await pullRequest.readFresh()
    const overview = await pullRequest.overview()

    expect(client.calls).toEqual(['graphql:PullRequestDetail'])
    expect(overview.pullRequest).toMatchObject({
      number: 65,
      headSha: 'head-sha',
      baseRef: 'main',
      author: 'octocat',
      state: 'open',
      mergeable: true,
      // REST's spelling, which every client already reads.
      mergeStateStatus: 'blocked',
      reviewStatus: 'review-required',
      labels: [{ name: 'bug', color: 'd73a4a' }],
      assignees: ['octocat'],
      requestedReviewers: [{ login: 'hubot', avatarUrl: 'https://avatars.test/hubot' }],
      autoMergeEnabled: false,
      requiredApprovingReviewCount: 0,
    })
    expect(overview.pullRequest.viewerPermissions.actions).toContain('merge')
    expect(overview.pullRequest.capabilities.mergeMethods).toEqual(['merge', 'squash', 'rebase'])
    expect(overview.pullRequest.capabilities.defaultMergeMethod).toBe('merge')
    // The timeline shows the full subject line, never GitHub's shortened headline.
    expect(overview.commits).toEqual([{ sha: 'c1', message: 'Commit c1', author: 'octocat', committedAt: '2026-08-01T11:00:00Z' }])
    expect(overview.reviewers.map(({ login, state }) => [login, state])).toEqual([
      ['monalisa', 'APPROVED'],
      ['linus', 'COMMENTED'],
      ['hubot', null],
    ])
  })

  test('the base branch rules come in the same answer, with no branch rules request', async () => {
    // WHY: the merge menu must not offer a method the base branch forbids, and
    // the merge row says how many approvals are still required. Both used to
    // cost two more requests on every page open.
    const client = countingClient({
      detail: detailWith({
        baseRef: {
          branchProtectionRule: { requiresLinearHistory: true, requiredApprovingReviewCount: 1 },
          rules: {
            nodes: [
              { type: 'PULL_REQUEST', parameters: { requiredApprovingReviewCount: 2, allowedMergeMethods: ['SQUASH', 'MERGE'] } },
              { type: 'DELETION', parameters: null },
            ],
          },
        },
      }),
    })
    const provider = new CountingProvider([client])

    const pullRequest = await provider.getPullRequest(repo, 65)

    expect(client.calls).toEqual(['graphql:PullRequestDetail'])
    // Linear history forbids a merge commit; the ruleset forbids a rebase.
    expect(pullRequest.capabilities.mergeMethods).toEqual(['squash'])
    expect(pullRequest.capabilities.defaultMergeMethod).toBe('squash')
    expect(pullRequest.requiredApprovingReviewCount).toBe(2)
  })

  test('a refusal under the base branch retries with gh for complete rules', async () => {
    // WHY: the account app can read the PR but lack access to branch rules.
    // The gh credential can supply those rules instead of showing unknown.
    const answer = githubPullRequestDetailAnswer()
    const client = countingClient({
      detail: () => {
        throw Object.assign(new Error('Resource not accessible by integration'), {
          data: answer,
          errors: [{ type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'baseRef', 'rules'] }],
        })
      },
    })
    const fallback = countingClient()
    fallback.credential.source = 'gh-cli'
    const provider = new CountingProvider([client, fallback])

    const pullRequest = await provider.getPullRequest(repo, 65)

    expect(fallback.calls).toEqual(['graphql:PullRequestDetail'])
    expect(pullRequest.requiredApprovingReviewCount).toBe(0)
    expect(pullRequest.capabilities.mergeMethods).toEqual(['merge', 'squash', 'rebase'])
  })

  test('a repository this credential cannot see moves to the next credential', async () => {
    // WHY: GraphQL hides a repository behind NOT_FOUND on HTTP 200. The gh
    // credential may still see it, so the one query must fall through as REST did.
    const hidden = countingClient({
      detail: () => {
        throw Object.assign(new Error("Could not resolve to a Repository with the name 'acme/app'."), {
          data: { viewer: { login: 'sidhu' }, repository: null },
          errors: [{ type: 'NOT_FOUND', path: ['repository'] }],
        })
      },
    })
    const visible = countingClient()
    const provider = new CountingProvider([hidden, visible])

    const pullRequest = await provider.getPullRequest(repo, 65)

    expect(hidden.calls).toEqual(['graphql:PullRequestDetail'])
    expect(visible.calls).toEqual(['graphql:PullRequestDetail'])
    expect(pullRequest.number).toBe(65)
  })

  test('an access error on a later commit page retries the whole overview with gh', async () => {
    const account = countingClient({
      detail: detailWith({ commits: { hasNextPage: true, endCursor: 'next', oids: ['account-only'] } }),
      commitsPage: () => {
        throw Object.assign(new Error('Organization blocks this app'), {
          data: { repository: null }, errors: [{ type: 'FORBIDDEN', path: ['repository'] }],
        })
      },
    })
    const gh = countingClient()
    gh.credential.source = 'gh-cli'
    const overview = await new CountingProvider([account, gh]).getPullRequestOverview(repo, 65)
    expect(account.calls).toEqual(['graphql:PullRequestDetail', 'graphql:PullRequestCommits'])
    expect(gh.calls).toEqual(['graphql:PullRequestDetail'])
    expect(overview.commits.map((commit) => commit.sha)).toEqual(['c1'])
  })

  test('a missing PR in a visible repository does not try another credential', async () => {
    const answer = githubPullRequestDetailAnswer()
    const account = countingClient({ detail: () => {
      throw Object.assign(new Error('Missing pull request'), {
        data: { ...answer, repository: { ...answer.repository, pullRequest: null } },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'] }],
      })
    } })
    const gh = countingClient()
    await expect(new CountingProvider([account, gh]).getPullRequest(repo, 65)).rejects.toThrow('Pull request #65 was not found')
    expect(gh.calls).toEqual([])
  })

  test('commits past the first hundred are read only when the pull request has them', async () => {
    const client = countingClient({
      detail: detailWith({ commits: { hasNextPage: true, endCursor: 'cursor-100', oids: ['c1'] } }),
      commitsPage: () => ({
        repository: {
          pullRequest: {
            commits: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ commit: { oid: 'c101', message: 'Late commit', committedDate: '2026-08-02T00:00:00Z', author: null } }],
            },
          },
        },
      }),
    })
    const provider = new CountingProvider([client])

    const overview = await provider.getPullRequestOverview(repo, 65)

    expect(client.calls).toEqual(['graphql:PullRequestDetail', 'graphql:PullRequestCommits'])
    expect(overview.commits.map((commit) => commit.sha)).toEqual(['c1', 'c101'])
    expect(overview.commits[1]).toMatchObject({ author: '', committedAt: '2026-08-02T00:00:00Z' })
  })
})

const detail = {
  number: 65,
  baseSha: 'base-sha',
  headSha: 'head-sha',
  headRepo: { owner: 'acme', repo: 'app', isFork: false },
} as PullRequest
const mergeBase = 'b'.repeat(40)
const diffRequest = { number: 65, baseSha: mergeBase, headSha: 'head-sha' }

describe('GitHub pull request diff', () => {
  test('a small pull request diff is one `.diff` request in one page', async () => {
    // WHY: one file page per hundred files cost a request each, and rebuilt the
    // patch from JSON. GitHub's diff media type gives the whole patch at once.
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
    const client = countingClient({ diff: async () => patch })
    const provider = new CountingProvider([client])
    // Opening the review read the diff base; the diff reuses it.
    await provider.getPullRequestDiffBase(repo, detail)
    client.calls.length = 0

    const slice = await provider.getPullRequestDiff(repo, detail, diffRequest)

    expect(client.calls).toEqual(['rest:pulls.get.diff'])
    expect(slice).toEqual({ patch, truncated: false, nextCursor: null })
  })

  test('a binary file in the `.diff` marks the patch incomplete', async () => {
    const client = countingClient({ diff: async () => 'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n' })
    const provider = new CountingProvider([client])

    const slice = await provider.getPullRequestDiff(repo, detail, diffRequest)

    expect(slice.truncated).toBe(true)
  })

  test('a diff GitHub refuses falls back to file pages, and later pages skip the `.diff`', async () => {
    // WHY: GitHub answers 406 for a diff past 300 files. The review must still
    // load, in the file pages the clients already walk.
    const client = countingClient({
      diff: async () => { throw Object.assign(new Error('Sorry, the diff exceeded the maximum number of files'), { status: 406 }) },
      files: (page) => ({
        data: [{ filename: `f${page}.ts`, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }],
        headers: page === 1 ? { link: '<https://api.github.com/next>; rel="next"' } : {},
      }),
    })
    const provider = new CountingProvider([client])

    const first = await provider.getPullRequestDiff(repo, detail, diffRequest)
    const second = await provider.getPullRequestDiff(repo, detail, { ...diffRequest, cursor: first.nextCursor ?? undefined })

    expect(first.nextCursor).toBe('2')
    expect(first.patch).toContain('diff --git a/f1.ts b/f1.ts')
    expect(second.nextCursor).toBeNull()
    // The diff base and the `.diff` go out together on the first page.
    expect(client.calls.slice(0, 2).sort()).toEqual(['rest:pulls.get.diff', 'rest:repos.compare'])
    expect(client.calls.slice(2)).toEqual(['rest:pulls.listFiles:1', 'rest:pulls.listFiles:2'])
  })

  test('a diff larger than the cap falls back to file pages', async () => {
    const client = countingClient({ diff: async () => 'x'.repeat(MAX_PULL_REQUEST_DIFF_BYTES + 1) })
    const provider = new CountingProvider([client])

    const slice = await provider.getPullRequestDiff(repo, detail, diffRequest)

    expect(slice.patch).toBe('')
    expect(client.calls).toContain('rest:pulls.listFiles:1')
  })

  test('both sides of a file are read at the same time', async () => {
    // WHY: expanding context waited for the old side before it asked for the
    // new one. Neither depends on the other.
    // Each read waits until both have started, so reads made one after the
    // other never finish and the test fails on its timeout.
    let started = 0
    let release!: () => void
    const bothStarted = new Promise<void>((resolve) => { release = resolve })
    const client = countingClient({
      content: async (ref, path) => {
        started += 1
        if (started === 2) release()
        await bothStarted
        return `${ref}:${path}`
      },
    })
    const provider = new CountingProvider([client])
    await provider.getPullRequestDiffBase(repo, detail)
    client.calls.length = 0

    const reading = provider.getPullRequestDiffFileContents(repo, detail, {
      ...diffRequest,
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      changeType: 'change',
    })
    expect(await reading).toEqual({ oldContents: `${mergeBase}:src/a.ts`, newContents: 'head-sha:src/a.ts' })
    expect(client.calls.sort()).toEqual([`rest:repos.getContent:${mergeBase}`, 'rest:repos.getContent:head-sha'])
  })

  test('file contents for a base that moved are refused', async () => {
    const client = countingClient()
    const provider = new CountingProvider([client])

    await expect(provider.getPullRequestDiffFileContents(repo, detail, {
      ...diffRequest,
      baseSha: 'c'.repeat(40),
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      changeType: 'change',
    })).rejects.toThrow('This pull request base changed.')
  })
})
