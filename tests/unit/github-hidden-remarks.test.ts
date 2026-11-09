import { describe, expect, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { GitHubProvider } from '@solus/server/providers/github/provider'
import { readGithubPullRequestDetail } from '@solus/server/providers/github/pull-request-detail'
import { toNeedsReviewPullRequest, type GqlNeedsReviewPullRequest } from '@solus/server/providers/github/pull-request-rows'
import type { PullRequestAccess } from '@solus/server/providers/github/pull-request-actions'
import { githubPullRequestDetailAnswer } from './helpers/github-pull-request-detail'

/**
 * A maintainer hides (minimizes) a comment or review on GitHub when it is spam,
 * off-topic, or outdated. Solus leaves it out of what the provider returns, so
 * no client and no agent reads it, and a hidden review casts no verdict.
 */

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }
const lastPage = { hasNextPage: false, endCursor: null }

function remark(id: string, createdAt: string, isMinimized = false) {
  return { id, author: { login: 'octocat', avatarUrl: '' }, body: id, createdAt, lastEditedAt: null, isMinimized, url: `https://github.com/${id}` }
}

function graphqlClient(answer: (query: string) => unknown): GitHubClient {
  return {
    rest: {},
    graphql: async (query: string) => answer(query),
    credential: { source: 'host', token: 'fixture-token' },
  } as unknown as GitHubClient
}

class FixtureProvider extends GitHubProvider {
  constructor(private readonly client: GitHubClient) {
    super()
  }

  protected override async clients(): Promise<GitHubClient[]> {
    return [this.client]
  }
}

describe('hidden GitHub remarks', () => {
  test('the conversation leaves out hidden comments and hidden reviews', async () => {
    // WHY: 253 hidden spam reviews still showed in full in the PR panel.
    const provider = new FixtureProvider(graphqlClient(() => ({
      repository: {
        pullRequest: {
          comments: {
            pageInfo: lastPage,
            nodes: [remark('c1', '2026-07-01T00:00:00Z'), remark('c2', '2026-07-02T00:00:00Z', true)],
          },
          reviews: {
            pageInfo: lastPage,
            nodes: [
              { ...remark('r1', '2026-07-03T00:00:00Z', true), submittedAt: '2026-07-03T00:00:00Z', state: 'CHANGES_REQUESTED' },
              { ...remark('r2', '2026-07-04T00:00:00Z'), submittedAt: '2026-07-04T00:00:00Z', state: 'APPROVED' },
            ],
          },
          timelineItems: { pageInfo: lastPage, nodes: [] },
        },
      },
    })))

    expect((await provider.listComments(repo, 7)).map((item) => item.id)).toEqual(['c1', 'r2'])
  })

  test('review threads leave out hidden comments, and a thread with none left', async () => {
    const thread = (id: string, comments: ReturnType<typeof remark>[]) => ({
      id, isResolved: false, isOutdated: false, path: 'src/a.ts', line: 1, diffSide: 'RIGHT', comments: { nodes: comments },
    })
    const provider = new FixtureProvider(graphqlClient(() => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: lastPage,
            nodes: [
              thread('T_hidden_root', [remark('t1', '2026-07-01T00:00:00Z', true), remark('t2', '2026-07-01T01:00:00Z')]),
              thread('T_all_hidden', [remark('t3', '2026-07-01T00:00:00Z', true)]),
            ],
          },
        },
      },
    })))

    const threads = await provider.listReviewThreads(repo, 7)

    expect(threads.map((entry) => [entry.id, entry.comments.map((comment) => comment.id)])).toEqual([
      ['T_hidden_root', ['t2']],
    ])
  })

  test('a hidden review names no reviewer and does not make the pull request reviewed', async () => {
    // WHY: a hidden review from a blocked account must not show its author as
    // a reviewer, nor mark a pull request with no other review as reviewed.
    const answer = githubPullRequestDetailAnswer()
    const pullRequest: Omit<typeof answer.repository.pullRequest, 'reviewDecision'> & { reviewDecision: string | null } = answer.repository.pullRequest
    pullRequest.reviewDecision = null
    pullRequest.reviewRequests = { nodes: [] }
    pullRequest.latestReviews = {
      totalCount: 1,
      nodes: [{ state: 'CHANGES_REQUESTED', isMinimized: true, author: { login: 'spammer', avatarUrl: 'https://avatars.test/spammer' } }],
    }
    pullRequest.latestOpinionatedReviews = {
      nodes: [{ state: 'CHANGES_REQUESTED', isMinimized: true, author: { login: 'spammer', avatarUrl: 'https://avatars.test/spammer' } }],
    }

    const detail = await readGithubPullRequestDetail(graphqlClient(() => answer), repo, 65)

    expect(detail.reviewers).toEqual([])
    expect(detail.pullRequest.reviewStatus).toBe('no-reviews')
  })

  test('a reviewer\'s approval stands when only their later comment is hidden', async () => {
    const answer = githubPullRequestDetailAnswer()
    const pullRequest = answer.repository.pullRequest
    pullRequest.reviewRequests = { nodes: [] }
    pullRequest.latestReviews = {
      totalCount: 1,
      nodes: [{ state: 'COMMENTED', isMinimized: true, author: { login: 'monalisa', avatarUrl: 'https://avatars.test/monalisa' } }],
    }

    const detail = await readGithubPullRequestDetail(graphqlClient(() => answer), repo, 65)

    expect(detail.reviewers.map(({ login, state }) => [login, state])).toEqual([['monalisa', 'APPROVED']])
  })

  test('list rows: GitHub\'s own decision wins; without one, only shown reviews count', () => {
    const access = { capabilities: {}, viewerPermissions: {} } as unknown as PullRequestAccess
    const row = (reviewDecision: GqlNeedsReviewPullRequest['reviewDecision'], hidden: boolean[], totalCount = hidden.length) =>
      toNeedsReviewPullRequest({
        number: 7, url: 'https://github.com/acme/app/pull/7', title: 'T', headRefOid: 'h', author: null, state: 'OPEN',
        createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', isDraft: false, labels: { nodes: [] },
        additions: 0, deletions: 0, reviewRequests: { nodes: [] }, assignees: { nodes: [] }, body: '', baseRefName: 'main',
        baseRefOid: 'b', headRefName: 'f', changedFiles: 0, mergeable: 'MERGEABLE', reviewDecision,
        latestReviews: { totalCount, nodes: hidden.map((isMinimized) => ({ isMinimized })) },
        baseRepository: null, headRepository: null,
      }, repo, access).reviewStatus

    expect(row(null, [true])).toBe('no-reviews')
    expect(row(null, [true, false])).toBe('reviewed')
    // Reviews past the page that was read count as shown.
    expect(row(null, [true], 2)).toBe('reviewed')
    expect(row('CHANGES_REQUESTED', [true])).toBe('changes-requested')
    expect(row('APPROVED', [true])).toBe('approved')
  })
})
