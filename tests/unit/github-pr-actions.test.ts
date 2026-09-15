import { describe, expect, test } from 'bun:test'
import {
  githubPullRequestAccess,
  githubPullRequestAccessFor,
  updateGithubPullRequestLifecycle,
} from '@solus/server/providers/github/pull-request-actions'
import type { GitHubClient } from '@solus/server/providers/github/octokit'

describe('GitHub pull request capabilities', () => {
  test('separates repository support from the viewer permission set', () => {
    // WHY: unsupported and unauthorized are different UI states. A read-only
    // viewer must not make provider features disappear for every user.
    const access = githubPullRequestAccess({
      viewer: 'reader',
      author: 'author',
      canWrite: false,
      canTriage: false,
      allowMergeCommit: false,
      allowSquashMerge: true,
      allowRebaseMerge: false,
    })

    expect(access.capabilities.actions).toContain('merge')
    expect(access.capabilities.mergeMethods).toEqual(['squash'])
    expect(access.viewerPermissions.actions).toEqual([])
    expect(access.viewerPermissions.reviewVerdicts).toEqual(['comment', 'approve', 'request-changes'])
    expect(access.viewerPermissions.requestReviewers).toBe(false)
    expect(access.viewerPermissions.manageLabels).toBe(false)
  })

  test('does not offer approval or change requests on the viewer own pull request', () => {
    const access = githubPullRequestAccess({
      viewer: 'Author',
      author: 'author',
      canWrite: true,
      canTriage: false,
      allowMergeCommit: true,
      allowSquashMerge: true,
      allowRebaseMerge: true,
    })

    expect(access.viewerPermissions.reviewVerdicts).toEqual(['comment'])
    expect(access.viewerPermissions.actions).toContain('merge')
    expect(access.viewerPermissions.actions).toContain('draft')
  })

  test('lets a triage viewer manage labels without granting write actions', () => {
    const access = githubPullRequestAccess({
      viewer: 'triager',
      author: 'author',
      canWrite: false,
      canTriage: true,
      allowMergeCommit: true,
      allowSquashMerge: true,
      allowRebaseMerge: true,
    })

    expect(access.viewerPermissions.manageLabels).toBe(true)
    expect(access.viewerPermissions.requestReviewers).toBe(false)
    expect(access.viewerPermissions.actions).toEqual([])
  })
})

describe('GitHub repository merge methods', () => {
  const repo = { host: 'github.com', owner: 'acme', repo: 'app' }
  /** What REST returns to everyone below admin: the three flags are null. */
  const restForNonAdmin = {
    rest: {
      repos: {
        get: async () => ({
          data: {
            permissions: { push: true, triage: true },
            allow_merge_commit: null,
            allow_squash_merge: null,
            allow_rebase_merge: null,
          },
        }),
      },
    },
  }

  test('reads the allowed methods from GraphQL when REST withholds them', async () => {
    // WHY: REST fills allow_*_merge for an admin only. Reading its null as
    // "allowed" offered a merge commit on a squash-only repository, so the
    // button named a merge the host would refuse.
    const client = {
      ...restForNonAdmin,
      graphql: async () => ({
        repository: { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false },
      }),
    } as unknown as GitHubClient

    const access = await githubPullRequestAccessFor(client, repo, 'viewer', 'author')
    expect(access.capabilities.mergeMethods).toEqual(['squash'])
  })

  test('keeps the pull request readable when the host refuses the GraphQL query', async () => {
    // WHY: the merge method is a label; the pull request is the feature. A host
    // without this query must still open, and the merge handler re-checks the
    // method against fresh detail before it merges.
    const client = {
      ...restForNonAdmin,
      graphql: async () => { throw new Error('GraphQL unavailable') },
    } as unknown as GitHubClient

    const access = await githubPullRequestAccessFor(client, repo, 'viewer', 'author')
    expect(access.capabilities.mergeMethods).toEqual(['merge', 'squash', 'rebase'])
  })
})

describe('GitHub pull request lifecycle', () => {
  test('rejects a stale head before it sends a mutation', async () => {
    // WHY: a state action shown for one revision must not silently apply after
    // the host moves the pull request to another revision.
    let updates = 0
    const client = {
      rest: {
        pulls: {
          update: async () => { updates++ },
        },
      },
      graphql: async () => { updates++ },
    } as unknown as GitHubClient

    await expect(updateGithubPullRequestLifecycle(
      client,
      { host: 'github.com', owner: 'acme', repo: 'app' },
      12,
      'close',
      'old-head',
      { headSha: 'new-head', nodeId: 'PR_node', draft: false },
    )).rejects.toThrow('This pull request changed')
    expect(updates).toBe(0)
  })

  test('returns the ready state from the mutation without a follow-up read', async () => {
    // WHY: GitHub's REST detail can briefly lag a successful GraphQL lifecycle
    // mutation. The mutation response is the completion boundary for the UI.
    let mutations = 0
    const client = {
      rest: { pulls: { update: async () => { throw new Error('not used') } } },
      graphql: async () => {
        mutations++
        return {
          markPullRequestReadyForReview: {
            pullRequest: { isDraft: false, state: 'OPEN', updatedAt: '2026-08-11T18:00:00Z' },
          },
        }
      },
    } as unknown as GitHubClient

    await expect(updateGithubPullRequestLifecycle(
      client,
      { host: 'github.com', owner: 'acme', repo: 'app' },
      12,
      'ready',
      'head',
      { headSha: 'head', nodeId: 'PR_node', draft: true },
    )).resolves.toEqual({
      state: 'open',
      draft: false,
      updatedAt: '2026-08-11T18:00:00Z',
    })
    expect(mutations).toBe(1)
  })
})
