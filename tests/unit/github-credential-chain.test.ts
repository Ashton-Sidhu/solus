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
 * These tests pin that a credential-specific access failure hands the same
 * call to the next one, and that domain failures do not.
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

type Answer = 'accepts' | 'rejects' | 'forbidden' | 'org-blocked' | 'not-found' | 'invalid'

interface ScriptedClient extends GitHubClient {
  calls: string[]
}

/** A client whose every call answers the same way, recording what was asked. */
function scriptedClient(source: GithubCredentialSource, answer: Answer): ScriptedClient {
  const calls: string[] = []
  const respond = <T>(name: string, data: T): { data: T } => {
    calls.push(name)
    if (answer === 'rejects') throw new GitHubReauthRequiredError()
    if (answer === 'forbidden') throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
    if (answer === 'org-blocked' && name !== 'users.getAuthenticated') {
      throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
    }
    if (answer === 'not-found') throw Object.assign(new Error('Not Found'), { status: 404 })
    if (answer === 'invalid') throw Object.assign(new Error('Validation Failed'), { status: 422 })
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
      list: async () => respond('pulls.list', [restPullRequest]),
      create: async () => respond('pulls.create', restPullRequest),
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

  test('organization access failures hand the request to the gh credential', async () => {
    // WHY: GitHub reports an OAuth app blocked by an organization as 403 or
    // hides the repository behind 404. The user's gh credential can still have
    // access, so both answers belong to credential selection.
    for (const answer of ['forbidden', 'not-found'] as const) {
      const host = scriptedClient('host', answer)
      const cli = scriptedClient('gh-cli', 'accepts')
      const provider = new ChainedProvider([host, cli])

      const pullRequest = await provider.getPullRequest(repo, 65)

      expect(host.calls).toEqual(['pulls.get'])
      expect(cli.calls).toContain('pulls.get')
      expect(pullRequest.number).toBe(65)
    }
  })

  test('the pull request list falls through an organization-blocked OAuth token', async () => {
    // WHY: the PR page and Git-section branch discovery share this list call.
    const host = scriptedClient('host', 'org-blocked')
    const cli = scriptedClient('gh-cli', 'accepts')
    const provider = new ChainedProvider([host, cli])

    const page = await provider.listPullRequestsPage(repo, { state: 'open', head: 'feature' }, 1, 1)

    expect(host.calls).toEqual(['pulls.list'])
    expect(cli.calls).toContain('pulls.list')
    expect(page.items[0]?.headRef).toBe('feature')
  })

  test('a repository-scoped viewer uses the same credential as its PR list', async () => {
    // WHY: review-attention flags must describe the account that could read the
    // organization repository, not an earlier OAuth account that only passed
    // the global /user check.
    const host = scriptedClient('host', 'org-blocked')
    const cli = scriptedClient('gh-cli', 'accepts')
    const provider = new ChainedProvider([host, cli])

    const viewer = await provider.getViewer(repo)

    expect(host.calls).toEqual(['users.getAuthenticated', 'repos.get'])
    expect(cli.calls).toEqual(['users.getAuthenticated', 'repos.get'])
    expect(viewer).toBe('sidhu')
  })

  test('a domain failure is final', async () => {
    // WHY: validation and conflict responses are not statements about which
    // credential may see the repository, so retrying them would add latency
    // and could blur the useful error.
    const host = scriptedClient('host', 'invalid')
    const cli = scriptedClient('gh-cli', 'accepts')
    const provider = new ChainedProvider([host, cli])

    await expect(provider.getPullRequest(repo, 65)).rejects.toThrow('Validation Failed')
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

  test('pull request creation uses the same organization-access fallback', async () => {
    // WHY: creation used to bypass the credential chain and start a raw gh
    // process, which gave this action a different auth policy from PR lists.
    const host = scriptedClient('host', 'forbidden')
    const cli = scriptedClient('gh-cli', 'accepts')
    const provider = new ChainedProvider([host, cli])

    const pullRequest = await provider.createPullRequest(repo, {
      baseRef: 'main',
      headRef: 'feature',
      title: 'Unify credentials',
      body: 'Use one provider path.',
    })

    expect(host.calls).toEqual(['pulls.create'])
    expect(cli.calls).toContain('pulls.create')
    expect(pullRequest.number).toBe(65)
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
