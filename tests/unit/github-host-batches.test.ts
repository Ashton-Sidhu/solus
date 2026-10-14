import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import { clientFor, type GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'
import { asBackgroundWork } from '@solus/server/providers/github/request-budget'
import { GitHubRateLimitedError } from '@solus/server/providers/github/rate-limit'

/**
 * What PR sync, the watcher, and check polls cost on GitHub
 * (docs/plans/pr-sync.md §11). A real Octokit client talks to a fake GitHub,
 * so the ETag layer runs as in production. The request counts are the point:
 * an unchanged poll costs no GraphQL points, and the repositories of one
 * account share one document.
 */

interface FakePullRequest {
  sha: string
  merged: boolean
  /** The conclusion of its one check run; null while it runs. */
  conclusion: string | null
}

interface GraphqlDocument {
  operation: string
  /** `owner/name#number` of each pull request the document names. */
  pullRequests: string[]
}

/** GitHub's REST and GraphQL answers for the repositories a test names. */
class FakeGitHub {
  readonly repositories = new Map<string, Map<number, FakePullRequest>>()
  /** Each repository's pull request numbers by head branch, newest first. */
  readonly heads = new Map<string, Map<string, number[]>>()
  /** Repositories that this account cannot see. */
  readonly hidden = new Set<string>()
  readonly documents: GraphqlDocument[] = []
  readonly rest: Array<{ path: string; status: number }> = []
  /** The next GraphQL answers, before any rows: a failure of the whole document. */
  readonly failures: Array<'bad-gateway' | 'rate-limited'> = []

  pullRequest(repository: string, number: number, pullRequest: FakePullRequest): void {
    const numbers = this.repositories.get(repository) ?? new Map<number, FakePullRequest>()
    numbers.set(number, pullRequest)
    this.repositories.set(repository, numbers)
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/graphql') return this.graphql(JSON.parse(String(init?.body)))
    const headers = new Headers(init?.headers)
    const body = this.restBody(url.pathname)
    if (!body) {
      this.rest.push({ path: url.pathname, status: 404 })
      return json({ message: 'Not Found' }, 404)
    }
    const etag = `"${Bun.hash(JSON.stringify(body))}"`
    const status = headers.get('if-none-match') === etag ? 304 : 200
    this.rest.push({ path: url.pathname, status })
    return status === 304 ? new Response(null, { status, headers: { etag } }) : json(body, 200, { etag })
  }

  private restBody(path: string) {
    if (path === '/user') return { login: 'sidhu', avatar_url: '' }
    const repository = /^\/repos\/([^/]+\/[^/]+)$/.exec(path)
    if (repository) return this.hidden.has(repository[1]) ? null : { permissions: { push: true } }
    const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path)
    if (pull) {
      const pullRequest = this.repositories.get(pull[1])?.get(Number(pull[2]))
      return pullRequest && { number: Number(pull[2]), head: { sha: pullRequest.sha }, merged_at: pullRequest.merged ? '2026-10-01T00:00:00Z' : null }
    }
    const commit = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/(check-runs|status)$/.exec(path)
    if (!commit) return null
    const pullRequest = [...this.repositories.get(commit[1])?.values() ?? []].find(({ sha }) => sha === commit[2])
    if (!pullRequest) return null
    return commit[3] === 'status'
      ? { state: 'success', statuses: [] }
      : { total_count: 1, check_runs: [{ id: 1, status: pullRequest.conclusion ? 'completed' : 'in_progress', conclusion: pullRequest.conclusion }] }
  }

  private graphql(request: { query: string; variables: Partial<Record<string, string>> }): Response {
    const operation = /query (\w+)/.exec(request.query)?.[1] ?? ''
    const document: GraphqlDocument = { operation, pullRequests: [] }
    this.documents.push(document)
    // The repository's merge settings, which a row's access reads once.
    if (!operation) {
      return json({ data: { repository: {
        mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: false, viewerDefaultMergeMethod: 'MERGE',
      } } })
    }
    const data: Partial<Record<string, Partial<Record<string, object | null>> | null>> = {}
    const errors: Array<{ type: string; message: string; path: string[] }> = []
    let alias = ''
    let repository = ''
    for (const [, repositoryAlias, index, number, headAlias, head] of request.query.matchAll(/(r(\d+)): repository|p(\d+): pullRequest\b|(h\d+): pullRequests\(headRefName: ("(?:[^"\\]|\\.)*")/g)) {
      if (headAlias) {
        const branch = JSON.parse(head) as string
        document.pullRequests.push(`${repository}@${branch}`)
        const rows = data[alias]
        if (rows) rows[headAlias] = { nodes: (this.heads.get(repository)?.get(branch) ?? []).map((pr) => headRow(repository, pr, branch)) }
        continue
      }
      if (repositoryAlias) {
        alias = repositoryAlias
        repository = `${request.variables[`o${index}`]}/${request.variables[`n${index}`]}`
        if (this.hidden.has(repository)) {
          data[alias] = null
          errors.push({ type: 'NOT_FOUND', message: `Could not resolve to a Repository with the name '${repository}'.`, path: [alias] })
        } else data[alias] = {}
        continue
      }
      document.pullRequests.push(`${repository}#${number}`)
      const rows = data[alias]
      const pullRequest = this.repositories.get(repository)?.get(Number(number))
      if (!rows) continue
      rows[`p${number}`] = pullRequest ? rowOf(operation, Number(number), pullRequest) : null
      if (!pullRequest) errors.push({ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest.', path: [alias, `p${number}`] })
    }
    const failure = this.failures.shift()
    if (failure === 'bad-gateway') return json({ message: 'Bad Gateway' }, 502)
    if (failure === 'rate-limited') return json({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] })
    return json(errors.length ? { data, errors } : { data })
  }

}

/** A pull request as a row of PR sync reads it. */
function headRow(repository: string, number: number, branch: string): object {
  return {
    number, url: `https://github.com/${repository}/pull/${number}`, title: `PR ${number}`, headRefOid: `head-${number}`,
    author: { login: 'sidhu', avatarUrl: '' }, state: 'OPEN', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', isDraft: false,
    labels: { nodes: [] }, additions: 1, deletions: 1, reviewRequests: { nodes: [] }, assignees: { nodes: [] }, body: '',
    baseRefName: 'main', baseRefOid: 'base', headRefName: branch, changedFiles: 1, mergeable: 'MERGEABLE',
    reviewDecision: null, reviews: { totalCount: 0 }, baseRepository: { nameWithOwner: repository },
    headRepository: { nameWithOwner: repository, name: repository.split('/')[1], owner: { login: 'acme' } },
  }
}

function rowOf(operation: string, number: number, pullRequest: FakePullRequest): object {
  const contexts = [{
    __typename: 'CheckRun', databaseId: 1, name: 'build', status: pullRequest.conclusion ? 'COMPLETED' : 'IN_PROGRESS',
    conclusion: pullRequest.conclusion, detailsUrl: null, startedAt: null, completedAt: null, isRequired: true, checkSuite: null,
  }]
  if (operation === 'PrChecks') {
    return { number, headRefOid: pullRequest.sha, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { totalCount: 1, nodes: contexts } } } }] } }
  }
  return {
    state: pullRequest.merged ? 'MERGED' : 'OPEN', mergeable: 'MERGEABLE', headRefOid: pullRequest.sha,
    comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] }, reviewThreads: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: [], statusContextCountsByState: [] } } } }] },
  }
}

function json(body: object, status = 200, headers: Partial<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

const github = new FakeGitHub()
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = github.fetch as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

let accounts = 0
/** A provider signed as an account of its own, so no test shares another's
 *  remembered answers. */
function providerOfNewAccount(): GitHubProvider {
  const client = clientFor({ source: 'host', token: `host-batches-${++accounts}` })
  return new class extends GitHubProvider {
    protected override async clients(): Promise<GitHubClient[]> {
      return [client]
    }
  }()
}

let repositoryCount = 0
/** A repository no other test has used. */
function newRepository(): RepoRef {
  return { host: 'github.com', owner: 'acme', repo: `app-${++repositoryCount}` }
}

const nameOf = (repo: RepoRef) => `${repo.owner}/${repo.repo}`

/** What GitHub saw while `read` ran. */
async function requestsOf(read: () => Promise<unknown>) {
  const documents = github.documents.length
  const rest = github.rest.length
  await read()
  return { documents: github.documents.slice(documents), rest: github.rest.slice(rest) }
}

describe('conditional checks', () => {
  test('a repeated poll of unchanged checks costs no GraphQL request, and REST answers 304', async () => {
    // WHY: the GraphQL check read costs points on every poll, and a review
    // pane polls every 15 seconds. A 304 does not count against the quota.
    const provider = providerOfNewAccount()
    const repo = newRepository()
    github.pullRequest(nameOf(repo), 7, { sha: 'sha-7', merged: false, conclusion: null })

    const first = await requestsOf(() => provider.listChecks(repo, [7]))
    const again = await requestsOf(() => provider.listChecks(repo, [7]))

    expect(first.documents.map(({ operation }) => operation)).toEqual(['PrChecks'])
    expect(again.documents).toEqual([])
    expect(again.rest.map(({ status }) => status)).toEqual([304, 304, 304])
  })

  test('a moved head is read again in GraphQL, for that pull request only', async () => {
    const provider = providerOfNewAccount()
    const repo = newRepository()
    github.pullRequest(nameOf(repo), 7, { sha: 'sha-7', merged: false, conclusion: 'SUCCESS' })
    github.pullRequest(nameOf(repo), 8, { sha: 'sha-8', merged: false, conclusion: 'SUCCESS' })
    await provider.listChecks(repo, [7, 8])

    github.pullRequest(nameOf(repo), 8, { sha: 'sha-8b', merged: false, conclusion: null })
    let checks: Awaited<ReturnType<GitHubProvider['listChecks']>> = []
    const moved = await requestsOf(async () => { checks = await provider.listChecks(repo, [7, 8]) })

    expect(moved.documents.map(({ pullRequests }) => pullRequests)).toEqual([[`${nameOf(repo)}#8`]])
    expect(checks.map(({ number, summary }) => [number, summary.headSha])).toEqual([[7, 'sha-7'], [8, 'sha-8b']])
    // Whether a check is required comes from the GraphQL read, also when it is held.
    expect(checks[0]?.summary.required.map(({ name }) => name)).toEqual(['build'])
  })

  test('the checks of a merged pull request are not polled again', async () => {
    // WHY: a merged pull request's checks do not change. A list of old pull
    // requests must not cost a request per row on every refresh.
    const provider = providerOfNewAccount()
    const repo = newRepository()
    github.pullRequest(nameOf(repo), 7, { sha: 'sha-7', merged: true, conclusion: 'SUCCESS' })
    await provider.listChecks(repo, [7])

    const again = await requestsOf(() => provider.listChecks(repo, [7]))

    expect(again).toEqual({ documents: [], rest: [] })
  })
})

describe('host-wide documents', () => {
  test('the check reads of three repositories on one account are one document', async () => {
    const provider = providerOfNewAccount()
    const repositories = [newRepository(), newRepository(), newRepository()]
    for (const repo of repositories) github.pullRequest(nameOf(repo), 1, { sha: `sha-${repo.repo}`, merged: false, conclusion: null })

    const { documents } = await requestsOf(() => asBackgroundWork(() => Promise.all(repositories.map((repo) => provider.listChecks(repo, [1])))))

    expect(documents).toHaveLength(1)
    expect(documents[0]?.pullRequests).toEqual(repositories.map((repo) => `${nameOf(repo)}#1`))
  })

  test('the watch fingerprints of three repositories on one account are one document', async () => {
    const provider = providerOfNewAccount()
    const repositories = [newRepository(), newRepository(), newRepository()]
    for (const repo of repositories) github.pullRequest(nameOf(repo), 4, { sha: `sha-${repo.repo}`, merged: false, conclusion: null })

    let answers: Array<Map<number, unknown>> = []
    const { documents } = await requestsOf(async () => {
      answers = await asBackgroundWork(() => Promise.all(repositories.map((repo) => provider.readWatchFingerprints(repo, [4]))))
    })

    expect(documents.map(({ operation }) => operation)).toEqual(['PrWatchFingerprints'])
    expect(answers.map((fingerprints) => fingerprints.has(4))).toEqual([true, true, true])
  })

  test('a document holds at most 25 pull requests', async () => {
    const provider = providerOfNewAccount()
    const repo = newRepository()
    const numbers = Array.from({ length: 30 }, (_, index) => index + 1)
    for (const number of numbers) github.pullRequest(nameOf(repo), number, { sha: `sha-${number}`, merged: false, conclusion: null })

    const { documents } = await requestsOf(() => provider.readWatchFingerprints(repo, numbers))

    expect(documents.map(({ pullRequests }) => pullRequests.length)).toEqual([25, 5])
  })

  test('a repository this account cannot see fails alone', async () => {
    // WHY: one hidden repository must not keep the others stale. Its own
    // failure still reaches its credential chain.
    const provider = providerOfNewAccount()
    const visible = newRepository()
    const hidden = newRepository()
    github.pullRequest(nameOf(visible), 2, { sha: 'sha-visible', merged: false, conclusion: null })
    github.hidden.add(nameOf(hidden))

    const { documents } = await requestsOf(async () => {
      const [seen, unseen] = await Promise.allSettled([provider.readWatchFingerprints(visible, [2]), provider.readWatchFingerprints(hidden, [2])])
      expect(seen.status === 'fulfilled' && seen.value.has(2)).toBe(true)
      expect(unseen.status).toBe('rejected')
    })

    expect(documents).toHaveLength(1)
  })

  test('when a shared document fails as a whole, each repository is read alone', async () => {
    const provider = providerOfNewAccount()
    const repositories = [newRepository(), newRepository()]
    for (const repo of repositories) github.pullRequest(nameOf(repo), 3, { sha: `sha-${repo.repo}`, merged: false, conclusion: null })
    github.failures.push('bad-gateway')

    let answers: Array<Map<number, unknown>> = []
    const { documents } = await requestsOf(async () => {
      answers = await Promise.all(repositories.map((repo) => provider.readWatchFingerprints(repo, [3])))
    })

    expect(documents.map(({ pullRequests }) => pullRequests.length)).toEqual([2, 1, 1])
    expect(answers.map((fingerprints) => fingerprints.has(3))).toEqual([true, true])
  })

  test('a rate limit fails every read of the document, without a read alone', async () => {
    // WHY: every repository spends the same account's quota, so another
    // request would only spend more of it.
    const provider = providerOfNewAccount()
    const repositories = [newRepository(), newRepository()]
    for (const repo of repositories) github.pullRequest(nameOf(repo), 3, { sha: `sha-${repo.repo}`, merged: false, conclusion: null })
    github.failures.push('rate-limited')

    const { documents } = await requestsOf(async () => {
      const results = await Promise.allSettled(repositories.map((repo) => provider.readWatchFingerprints(repo, [3])))
      for (const result of results) {
        expect(result.status === 'rejected' && result.reason instanceof GitHubRateLimitedError).toBe(true)
      }
    })

    expect(documents).toHaveLength(1)
  })
})

describe('PR sync branch lookups', () => {
  const headDocuments = (documents: GraphqlDocument[]) => documents.filter(({ operation }) => operation === 'PrSyncByHead')
  function opened(repo: RepoRef, branch: string, numbers: number[]): void {
    const heads = github.heads.get(nameOf(repo)) ?? new Map<string, number[]>()
    heads.set(branch, numbers)
    github.heads.set(nameOf(repo), heads)
  }

  test('three unmatched branches in two repositories on one account are one document, and read no branch rules', async () => {
    // WHY: branches are looked up when a turn ends, and several sessions can
    // end at once. One document per repository spent a request each.
    const provider = providerOfNewAccount()
    const [first, second] = [newRepository(), newRepository()]
    opened(first, 'topic-a', [4])
    opened(second, 'topic-c', [9, 7])

    let answers: Array<Map<string, Array<{ number: number }>>> = []
    const { documents, rest } = await requestsOf(async () => {
      answers = await asBackgroundWork(() => Promise.all([
        provider.getPullRequestsByHead(first, ['topic-a', 'topic-b']),
        provider.getPullRequestsByHead(second, ['topic-c']),
      ]))
    })

    expect(headDocuments(documents).map(({ pullRequests }) => pullRequests)).toEqual([[
      `${nameOf(first)}@topic-a`, `${nameOf(first)}@topic-b`, `${nameOf(second)}@topic-c`,
    ]])
    expect(answers.map((byHead) => [...byHead].map(([head, rows]) => [head, rows.map(({ number }) => number)]))).toEqual([
      [['topic-a', [4]], ['topic-b', []]],
      [['topic-c', [9, 7]]],
    ])
    expect(documents.some(({ operation }) => operation === 'BranchProtection')).toBe(false)
    expect(rest.some(({ path }) => path.includes('/rules/branches/'))).toBe(false)
  })

  test('a branch name cannot leave its string in the document', async () => {
    const provider = providerOfNewAccount()
    const repo = newRepository()
    const branch = 'odd"name\\x'
    opened(repo, branch, [3])

    const answer = await asBackgroundWork(() => provider.getPullRequestsByHead(repo, [branch]))

    expect(answer.get(branch)?.map(({ number }) => number)).toEqual([3])
  })

  test('a spent quota fails the lookups of every repository with one request', async () => {
    const provider = providerOfNewAccount()
    const repositories = [newRepository(), newRepository()]
    github.failures.push('rate-limited')

    const { documents } = await requestsOf(async () => {
      const results = await asBackgroundWork(() => Promise.allSettled(repositories.map((repo) => provider.getPullRequestsByHead(repo, ['topic']))))
      for (const result of results) {
        expect(result.status === 'rejected' && result.reason instanceof GitHubRateLimitedError).toBe(true)
      }
    })

    expect(documents).toHaveLength(1)
  })
})
