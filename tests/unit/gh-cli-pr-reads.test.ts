import { describe, expect, mock, test } from 'bun:test'
import type { GitHubAuth } from '@solus/server/providers/github/auth'

/**
 * Reading pull requests when the API cannot answer.
 *
 * The credential Solus holds and the credential `gh` holds are different
 * credentials, and only writes ever used the second one. A host whose token is
 * missing or expired therefore answered every read with "GitHub is not
 * connected", and every surface that names a pull request — the sidebar chip
 * most visibly — went blank about pull requests the user could see existed.
 *
 * These tests pin the shape of the CLI answer, because a mapper that quietly
 * disagrees with the adapter is the same defect one layer down: two ways to
 * read one pull request that describe it differently.
 */

interface RecordedCommand {
  bin: string
  args: string[]
}

const commands: RecordedCommand[] = []
let responses: Record<string, string> = {}

// A module mock is process-wide, so this stands in for `exec` in every test
// file that runs after this one. It therefore has to carry the module's whole
// surface: leaving `git` out breaks the import of any git code a later file
// loads, in a place that has nothing to do with `gh`.
mock.module('@solus/server/git/exec', () => ({
  git: () => '',
  runAsync: async (bin: string, args: string[]) => {
    commands.push({ bin, args })
    if (args[0] === 'repo') return responses.repo ?? '{}'
    if (args[0] === 'api' && args[1] === 'graphql') return responses.checks ?? '[]'
    if (args[0] === 'api' && args.some((arg) => arg.includes('/compare/'))) return responses.compare ?? '{}'
    if (args[0] === 'api') return responses.viewer ?? '{"login":"sidhu"}'
    if (args[0] === 'auth' && args[1] === 'token') return responses.token ?? ''
    if (args[1] === 'view') return responses.view ?? '{}'
    return responses.list ?? '[]'
  },
}))

const ghPullRequest = (overrides: Record<string, unknown> = {}) => ({
  number: 65,
  url: 'https://github.com/acme/app/pull/65',
  title: 'Consolidate pull request state',
  body: 'why',
  state: 'MERGED',
  isDraft: false,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  author: { login: 'sidhu' },
  baseRefName: 'main',
  baseRefOid: 'base-sha',
  headRefName: 'feature/consolidate',
  headRefOid: 'head-sha',
  headRepository: { name: 'app' },
  headRepositoryOwner: { login: 'acme' },
  isCrossRepository: false,
  additions: 12,
  deletions: 3,
  changedFiles: 4,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  labels: [{ name: 'bug', color: 'ff0000' }],
  assignees: [{ login: 'sidhu' }],
  reviewRequests: [{ login: 'reviewer' }],
  ...overrides,
})

const repo = { host: 'github.com', owner: 'acme', repo: 'app' }

function reset(): void {
  commands.length = 0
  responses = {
    repo: JSON.stringify({
      viewerPermission: 'WRITE',
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: false,
    }),
    viewer: '{"login":"sidhu"}',
  }
}

describe('reading one pull request through gh', () => {
  test('describes it in the same shape the adapter would', async () => {
    reset()
    responses.view = JSON.stringify(ghPullRequest())
    const { ghGetPullRequest } = await import('@solus/server/providers/github/gh-cli')

    const pullRequest = await ghGetPullRequest(repo, 65)

    expect(pullRequest.number).toBe(65)
    expect(pullRequest.title).toBe('Consolidate pull request state')
    // A merged pull request must read as merged and not as closed: the chip
    // draws a different glyph for each, and the task-completion rule reads it.
    expect(pullRequest.state).toBe('merged')
    expect(pullRequest.headRef).toBe('feature/consolidate')
    expect(pullRequest.headSha).toBe('head-sha')
    expect(pullRequest.baseSha).toBe('base-sha')
    expect(pullRequest.baseRepo).toEqual(repo)
    expect(pullRequest.mergeable).toBe(true)
    expect(pullRequest.requestedReviewers).toEqual(['reviewer'])
  })

  test('names the repository rather than relying on a checkout', async () => {
    // WHY: this path runs where no worktree is guaranteed — a task links a pull
    // request in a project this client has no checkout of.
    reset()
    responses.view = JSON.stringify(ghPullRequest())
    const { ghGetPullRequest } = await import('@solus/server/providers/github/gh-cli')

    await ghGetPullRequest(repo, 65)

    const view = commands.find((command) => command.args[1] === 'view')
    expect(view?.args).toContain('--repo')
    expect(view?.args).toContain('github.com/acme/app')
  })

  test('reports mergeability the host has not computed as unknown', async () => {
    // The contract's null means "the host is still working it out". A CLI answer
    // of UNKNOWN is that same state, and must not read as "has conflicts".
    reset()
    responses.view = JSON.stringify(ghPullRequest({ mergeable: 'UNKNOWN' }))
    const { ghGetPullRequest } = await import('@solus/server/providers/github/gh-cli')

    expect((await ghGetPullRequest(repo, 65)).mergeable).toBeNull()
    responses.view = JSON.stringify(ghPullRequest({ mergeable: 'CONFLICTING' }))
    expect((await ghGetPullRequest(repo, 65)).mergeable).toBe(false)
  })

  test('normalizes the CLI merge state to the REST vocabulary', async () => {
    // WHY: every conflict surface reads GitHub REST's lower-case `dirty` word.
    // `gh` returns `DIRTY`; passing it through made the project rail hide the
    // conflict only when it had used the fallback credential.
    reset()
    responses.view = JSON.stringify(ghPullRequest({ mergeStateStatus: 'DIRTY' }))
    const { ghGetPullRequest } = await import('@solus/server/providers/github/gh-cli')

    expect((await ghGetPullRequest(repo, 65)).mergeStateStatus).toBe('dirty')
  })

  test('grants only the actions the viewer permission allows', async () => {
    reset()
    // A repository of its own: what a viewer may do is read once per repository
    // and kept, the same way the adapter memoises it, so reusing one here would
    // read the permission the test above established.
    const readOnly = { host: 'github.com', owner: 'acme', repo: 'read-only' }
    responses.repo = JSON.stringify({
      viewerPermission: 'READ',
      mergeCommitAllowed: true,
      squashMergeAllowed: false,
      rebaseMergeAllowed: false,
    })
    responses.view = JSON.stringify(ghPullRequest({ author: { login: 'someone-else' } }))
    const { ghGetPullRequest } = await import('@solus/server/providers/github/gh-cli')

    const pullRequest = await ghGetPullRequest(readOnly, 65)

    // A reader who did not open it may not merge it or change its lifecycle.
    expect(pullRequest.viewerPermissions.actions).toEqual([])
    expect(pullRequest.capabilities.mergeMethods).toEqual(['merge'])
  })
})

describe('preparing a pull request review through gh', () => {
  test('resolves the merge base when the provider adapter is disconnected', async () => {
    // WHY: guide preparation needs the merge base immediately after its PR
    // metadata read. Falling back for only the first read still leaves the
    // whole guide blocked on a missing Solus OAuth connection.
    reset()
    responses.compare = JSON.stringify({
      merge_base_commit: { sha: 'merge-base-sha' },
      commits: [{ sha: 'head-sha' }],
    })
    responses.view = JSON.stringify(ghPullRequest())
    const { ghGetPullRequest, ghGetPullRequestDiffBase } = await import('@solus/server/providers/github/gh-cli')
    const pullRequest = await ghGetPullRequest(repo, 65)

    const diffBase = await ghGetPullRequestDiffBase(repo, pullRequest)

    expect(diffBase).toBe('merge-base-sha')
    const command = commands.find((entry) => entry.args.some((arg) => arg.includes('/compare/')))
    expect(command?.args).toContain('--hostname')
    expect(command?.args).toContain('github.com')
    expect(command?.args.some((arg) => arg.includes('base-sha...acme%3Afeature%2Fconsolidate'))).toBe(true)
  })

  test('the provider carries a disconnected adapter through to the gh merge-base fallback', async () => {
    reset()
    responses.view = JSON.stringify(ghPullRequest())
    responses.compare = JSON.stringify({
      merge_base_commit: { sha: 'merge-base-sha' },
      commits: [{ sha: 'head-sha' }],
    })
    const [{ ghGetPullRequest }, { GitHubProvider }] = await Promise.all([
      import('@solus/server/providers/github/gh-cli'),
      import('@solus/server/providers/github/provider'),
    ])
    const disconnectedAuth = {
      getAccessToken: async () => { throw new Error('GitHub is not connected') },
    }
    const provider = new GitHubProvider(disconnectedAuth as unknown as GitHubAuth)
    const pullRequest = await ghGetPullRequest(repo, 65)

    expect(await provider.getPullRequestDiffBase(repo, pullRequest)).toBe('merge-base-sha')
  })

  test('rejects a comparison that no longer ends at the requested PR head', async () => {
    reset()
    responses.compare = JSON.stringify({
      merge_base_commit: { sha: 'merge-base-sha' },
      commits: [{ sha: 'new-head-sha' }],
    })
    responses.view = JSON.stringify(ghPullRequest())
    const { ghGetPullRequest, ghGetPullRequestDiffBase } = await import('@solus/server/providers/github/gh-cli')
    const pullRequest = await ghGetPullRequest(repo, 65)

    await expect(ghGetPullRequestDiffBase(repo, pullRequest))
      .rejects.toThrow('This pull request changed while its diff base was loading.')
  })

  test('reads the gh credential for authenticated git checkout fallback', async () => {
    reset()
    responses.token = 'gh-cli-token'
    const { ghAuthToken } = await import('@solus/server/providers/github/gh-cli')

    expect(await ghAuthToken('github.com')).toBe('gh-cli-token')
    expect(commands.at(-1)?.args).toEqual(['auth', 'token', '--hostname', 'github.com'])
  })
})

describe('listing pull requests through gh', () => {
  test('orders by most recent activity, as every surface below it expects', async () => {
    reset()
    responses.list = JSON.stringify([
      ghPullRequest({ number: 1, updatedAt: '2026-08-01T00:00:00Z' }),
      ghPullRequest({ number: 2, updatedAt: '2026-08-09T00:00:00Z' }),
    ])
    const { ghListPullRequestsPage } = await import('@solus/server/providers/github/gh-cli')

    const page = await ghListPullRequestsPage(repo, { state: 'all' })

    expect(page.items.map((item) => item.number)).toEqual([2, 1])
    expect(page.hasMore).toBe(false)
  })

  test('passes a head-branch filter through, which is how a branch finds its pull request', async () => {
    reset()
    responses.list = JSON.stringify([ghPullRequest({ number: 65 })])
    const { ghListPullRequestsPage } = await import('@solus/server/providers/github/gh-cli')

    await ghListPullRequestsPage(repo, { state: 'all', head: 'feature/consolidate' })

    const list = commands.find((command) => command.args[1] === 'list')
    expect(list?.args).toContain('--head')
    expect(list?.args).toContain('feature/consolidate')
  })

  test('reports another page when the host had more rows than the page held', async () => {
    reset()
    responses.list = JSON.stringify([
      ghPullRequest({ number: 1 }),
      ghPullRequest({ number: 2 }),
      ghPullRequest({ number: 3 }),
    ])
    const { ghListPullRequestsPage } = await import('@solus/server/providers/github/gh-cli')

    const page = await ghListPullRequestsPage(repo, { state: 'all' }, 1, 2)

    expect(page.items).toHaveLength(2)
    expect(page.hasMore).toBe(true)
  })
})

describe('reading pull request checks through gh', () => {
  test('keeps required checks separate from optional checks', async () => {
    reset()
    responses.checks = JSON.stringify([
      {
        number: 65,
        headRefOid: 'head-sha',
        commits: {
          nodes: [{
            commit: {
              statusCheckRollup: {
                state: 'FAILURE',
                contexts: {
                  totalCount: 2,
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      databaseId: 11,
                      name: 'test',
                      status: 'COMPLETED',
                      conclusion: 'SUCCESS',
                      detailsUrl: 'https://github.com/acme/app/actions/runs/11',
                      startedAt: '2026-08-01T00:00:00Z',
                      completedAt: '2026-08-01T00:01:00Z',
                      isRequired: true,
                      checkSuite: { app: { name: 'GitHub Actions' } },
                    },
                    {
                      __typename: 'StatusContext',
                      context: 'preview',
                      state: 'FAILURE',
                      targetUrl: null,
                      description: 'Preview failed',
                      createdAt: '2026-08-01T00:00:00Z',
                      isRequired: false,
                    },
                  ],
                },
              },
            },
          }],
        },
      },
    ])
    const { ghListChecks } = await import('@solus/server/providers/github/gh-cli')

    const checks = await ghListChecks(repo, [65])

    expect(checks[0]?.summary.state).toBe('passing')
    expect(checks[0]?.summary.required.map((check) => check.name)).toEqual(['test'])
    expect(checks[0]?.summary.optional.map((check) => check.name)).toEqual(['preview'])
    const command = commands.find((entry) => entry.args[0] === 'api' && entry.args[1] === 'graphql')
    expect(command?.args).toContain('--hostname')
    expect(command?.args).toContain('github.com')
    expect(command?.args).toContain('owner=acme')
    expect(command?.args).toContain('repo=app')
  })
})
