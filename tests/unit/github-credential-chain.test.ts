import { describe, expect, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import type { GithubCredentialSource } from '@solus/server/providers/github/credentials'
import { GitHubReauthRequiredError, type GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'

/**
 * One request, many credentials.
 *
 * Solus can sign a GitHub request three ways — a paired device's delegated
 * token, the host's own connection, or whatever `gh` is signed in as — and
 * every one of them drives the same REST and GraphQL client. Falling back is
 * therefore a question of *which credential*, never of *which implementation*.
 * These tests pin that a rejected credential hands the same call to the next
 * one, and that nothing else does.
 */

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }

const restPullRequest = {
  node_id: 'PR_1',
  number: 65,
  html_url: 'https://github.com/acme/app/pull/65',
  title: 'Consolidate pull request state',
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

type Answer = 'accepts' | 'rejects' | 'not-found'

interface ScriptedClient extends GitHubClient {
  calls: string[]
}

/** A client whose every call answers the same way, recording what was asked. */
function scriptedClient(source: GithubCredentialSource, answer: Answer): ScriptedClient {
  const calls: string[] = []
  const respond = <T>(name: string, data: T): { data: T } => {
    calls.push(name)
    if (answer === 'rejects') throw new GitHubReauthRequiredError()
    if (answer === 'not-found') throw Object.assign(new Error('Not Found'), { status: 404 })
    return { data }
  }
  const rest = {
    users: { getAuthenticated: async () => respond('users.getAuthenticated', { login: 'sidhu' }) },
    repos: {
      get: async () => respond('repos.get', {
        permissions: { push: true },
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
      }),
    },
    pulls: {
      get: async () => respond('pulls.get', restPullRequest),
      merge: async () => respond('pulls.merge', { merged: true, message: 'Pull Request successfully merged' }),
    },
  }
  const graphql = async () => respond('graphql', { resolveReviewThread: { thread: { id: 'T_1' } } }).data
  return { rest, graphql, credential: { source, token: `${source}-token` }, calls } as unknown as ScriptedClient
}

class ChainedProvider extends GitHubProvider {
  constructor(private readonly chain: GitHubClient[]) {
    super()
  }

  protected override async clients(): Promise<GitHubClient[]> {
    return this.chain
  }
}

describe('GitHub requests run down the credential chain', () => {
  test('a rejected credential hands the same read to the next one, answered in the same shape', async () => {
    // WHY: the fallback used to be a second implementation over `gh pr view`,
    // which carried no avatars and spelled merge states differently. One client
    // per credential means no surface can tell which credential answered.
    const host = scriptedClient('host', 'rejects')
    const cli = scriptedClient('gh-cli', 'accepts')
    const provider = new ChainedProvider([host, cli])

    const pullRequest = await provider.getPullRequest(repo, 65)

    expect(host.calls).toEqual(['pulls.get'])
    expect(cli.calls).toContain('pulls.get')
    expect(pullRequest.authorAvatarUrl).toBe('https://avatars.test/sidhu')
    expect(pullRequest.viewerPermissions.actions).toContain('merge')
  })

  test('an answer that is not a credential rejection is final', async () => {
    // WHY: retrying a 404 or a stale-head error through another credential
    // doubled the latency of every real failure and replaced its message with
    // "failed through the provider adapter and CLI".
    const host = scriptedClient('host', 'not-found')
    const cli = scriptedClient('gh-cli', 'accepts')
    const provider = new ChainedProvider([host, cli])

    await expect(provider.getPullRequest(repo, 65)).rejects.toThrow('Not Found')
    expect(cli.calls).toEqual([])
  })

  test('every credential rejected reads as the rejection', async () => {
    const provider = new ChainedProvider([scriptedClient('host', 'rejects'), scriptedClient('gh-cli', 'rejects')])

    await expect(provider.getPullRequest(repo, 65)).rejects.toBeInstanceOf(GitHubReauthRequiredError)
  })

  test('no credential at all reads as GitHub not connected', async () => {
    // WHY: the client keys its "connect GitHub" empty state on this message.
    const provider = new ChainedProvider([])

    await expect(provider.getPullRequest(repo, 65)).rejects.toThrow('GitHub is not connected')
  })

  test('writes run down the same chain as reads', async () => {
    // WHY: a user signed in to `gh` expects merge and resolve to work as well as
    // the reads did. One rule for both, decided here rather than per method.
    const host = scriptedClient('host', 'rejects')
    const cli = scriptedClient('gh-cli', 'accepts')
    const provider = new ChainedProvider([host, cli])

    const merge = await provider.mergePullRequest(repo, 65, 'squash')
    await provider.resolveThread(repo, 'T_1')

    expect(merge.merged).toBe(true)
    expect(host.calls).toEqual(['pulls.merge', 'graphql'])
    expect(cli.calls).toEqual(['pulls.merge', 'graphql'])
  })

  test('the viewer is read once per credential, not once per row', async () => {
    // WHY: a page of pull requests asks for access per row. The old fallback
    // re-read `/user` for every one of them.
    const cli = scriptedClient('gh-cli', 'accepts')
    const provider = new ChainedProvider([cli])

    await Promise.all([provider.getPullRequest(repo, 65), provider.getPullRequest(repo, 65)])

    expect(cli.calls.filter((call) => call === 'users.getAuthenticated')).toHaveLength(1)
    expect(cli.calls.filter((call) => call === 'repos.get')).toHaveLength(1)
  })
})
