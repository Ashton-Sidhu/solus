import { describe, expect, test } from 'bun:test'
import { isGithubCredentialAccessFailure, type GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'
import { canonicalRepoRef } from '@solus/server/providers/github/canonical-repo'
import { ConditionalChecks } from '@solus/server/providers/github/conditional-checks'
import { githubPullRequestAccessFor } from '@solus/server/providers/github/pull-request-actions'
import { runGithubRequest } from '@solus/server/providers/github/request'
import { GitHubRateLimitedError } from '@solus/server/providers/github/rate-limit'

const repo = { host: 'github.com', owner: 'fallback-tests', repo: 'app' }
const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }

function failure(type: string) {
  return Object.assign(new Error(type), {
    data: { repository: null, r0: null },
    errors: [{ type, path: ['repository'] }],
  })
}

function client(error?: Error): GitHubClient {
  const respond = () => { if (error) throw error }
  return {
    credential: { source: error ? 'account' : 'gh-cli', token: 'unused-test-token' },
    rest: {
      checks: { listForRef: async () => ({ data: { total_count: 0, check_runs: [] } }) },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }), get: async () => {
        respond()
        return { data: { full_name: 'fallback-tests/app', permissions: { push: true } } }
      } },
      pulls: { get: async () => { respond(); return { data: { head: { sha: 'head' }, merged_at: null } } } },
    },
    graphql: async () => {
      respond()
      return {
        repository: {
          mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false,
          pullRequest: { files: page, reviewThreads: page, comments: page, reviews: page, timelineItems: page },
        },
        r0: { p1: null },
      }
    },
  } as unknown as GitHubClient
}

class ReadProvider extends GitHubProvider {
  constructor(private readonly chain: GitHubClient[]) { super() }
  protected override async clients(): Promise<GitHubClient[]> { return this.chain }
}

describe('GitHub read credential fallback', () => {
  test('an access error is recognized beside other GraphQL errors, but quota takes precedence', () => {
    expect(isGithubCredentialAccessFailure({ errors: [{ type: 'INVALID' }, { type: 'FORBIDDEN' }] })).toBe(true)
    expect(isGithubCredentialAccessFailure({ errors: [{ type: 'INVALID' }] })).toBe(false)
    expect(isGithubCredentialAccessFailure({ errors: [{ type: 'FORBIDDEN' }, { type: 'RATE_LIMITED' }] })).toBe(false)
  })
  const reads = [
    { name: 'review threads', read: (provider: GitHubProvider) => provider.listReviewThreads(repo, 1) },
    { name: 'comments', read: (provider: GitHubProvider) => provider.listComments(repo, 1) },
    { name: 'file statistics', read: (provider: GitHubProvider) => provider.listPullRequestFileStats(repo, 1) },
    { name: 'viewed files', read: (provider: GitHubProvider) => provider.listViewedFiles(repo, 1) },
    { name: 'PR sync', read: (provider: GitHubProvider) => provider.getPullRequests(repo, [1]) },
    { name: 'watch fingerprints', read: (provider: GitHubProvider) => provider.readWatchFingerprints(repo, [1]) },
  ]
  for (const { name, read } of reads) {
    test(`${name} retries an app permission error with gh`, async () => {
      const account = client(failure('FORBIDDEN'))
      const gh = client()
      const answer = gh.graphql
      let fallbackReads = 0
      gh.graphql = async (query, variables) => { fallbackReads++; return answer(query, variables) }
      await read(new ReadProvider([account, gh]))
      expect(fallbackReads).toBe(1)
    })
  }

  for (const type of ['FORBIDDEN', 'RATE_LIMITED']) {
    test(`merge settings preserve ${type} for the request policy`, async () => {
      const error = failure(type)
      const account = client()
      account.graphql = async () => { throw error }
      const gh = client()
      const reading = runGithubRequest('test_merge_settings', repo.host, [account, gh], (current) =>
        githubPullRequestAccessFor(current, repo, 'viewer', 'author'))
      if (type === 'RATE_LIMITED') await expect(reading).rejects.toBeInstanceOf(GitHubRateLimitedError)
      else expect((await reading).capabilities.mergeMethods).toEqual(['squash'])
    })

    test(`repository-name lookup preserves ${type} for the request policy`, async () => {
      const lookupRepo = { ...repo, repo: `lookup-${type}` }
      const reading = runGithubRequest('test_canonical_repo', repo.host, [client(failure(type)), client()], (current) =>
        canonicalRepoRef(current, lookupRepo))
      if (type === 'RATE_LIMITED') await expect(reading).rejects.toBeInstanceOf(GitHubRateLimitedError)
      else expect(await reading).toEqual(repo)
    })

    test(`check validators preserve ${type} before a GraphQL read`, async () => {
      const account = client(failure(type))
      const gh = client()
      const checks = new ConditionalChecks()
      const graphqlSources: string[] = []
      await runGithubRequest('test_checks', repo.host, [account, gh], (current) =>
        checks.read(current, repo, [1], async () => {
          graphqlSources.push(current.credential.source)
          return []
        })).then(() => {
          expect(type).toBe('FORBIDDEN')
          expect(graphqlSources).toEqual(['gh-cli'])
        }, (error) => {
          expect(type).toBe('RATE_LIMITED')
          expect(error).toBeInstanceOf(GitHubRateLimitedError)
          expect(graphqlSources).toEqual([])
        })
    })
  }
})
