import { describe, expect, test } from 'bun:test'
import {
  githubPullRequestAccess,
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
      allowMergeCommit: false,
      allowSquashMerge: true,
      allowRebaseMerge: false,
    })

    expect(access.capabilities.actions).toContain('merge')
    expect(access.capabilities.mergeMethods).toEqual(['squash'])
    expect(access.viewerPermissions.actions).toEqual([])
    expect(access.viewerPermissions.reviewVerdicts).toEqual(['comment', 'approve', 'request-changes'])
    expect(access.viewerPermissions.requestReviewers).toBe(false)
  })

  test('does not offer approval or change requests on the viewer own pull request', () => {
    const access = githubPullRequestAccess({
      viewer: 'Author',
      author: 'author',
      canWrite: true,
      allowMergeCommit: true,
      allowSquashMerge: true,
      allowRebaseMerge: true,
    })

    expect(access.viewerPermissions.reviewVerdicts).toEqual(['comment'])
    expect(access.viewerPermissions.actions).toContain('merge')
    expect(access.viewerPermissions.actions).toContain('draft')
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
