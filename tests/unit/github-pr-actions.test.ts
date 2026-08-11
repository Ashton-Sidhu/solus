import { describe, expect, test } from 'bun:test'
import {
  githubPullRequestAccess,
  updateGithubPullRequestLifecycle,
} from '../../src/main/providers/github/pull-request-actions'
import type { GitHubClient } from '../../src/main/providers/github/octokit'

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
          get: async () => ({ data: { head: { sha: 'new-head' }, node_id: 'PR_node' } }),
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
    )).rejects.toThrow('This pull request changed')
    expect(updates).toBe(0)
  })
})
