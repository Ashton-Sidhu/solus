import type { PullRequest } from '@solus/contracts/providers'

/**
 * A complete `PullRequest`, because there is no partial one.
 *
 * Shared so the eight suites that need a pull request do not each restate the
 * capability and permission blocks — and so a new required field is added in one
 * place rather than found eight times by a failing test.
 *
 * The defaults describe the ordinary case: open, same-repository, and a viewer
 * who may act on it. A test that cares about draft, forks, or a viewer without
 * write access says so in its overrides, which is what makes those tests read
 * as being about that difference.
 */
export function pullRequestFixture(
  number: number,
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    url: `https://github.com/acme/repo/pull/${number}`,
    title: `PR ${number}`,
    headSha: `head-${number}`,
    baseSha: `base-${number}`,
    baseRepo: { host: 'github.com', owner: 'acme', repo: 'repo' },
    headRepo: { owner: 'acme', repo: 'repo', isFork: false },
    author: 'octocat',
    authorAvatarUrl: '',
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
    body: '',
    baseRef: 'main',
    headRef: `feature/${number}`,
    changedFiles: null,
    mergeable: null,
    mergeStateStatus: null,
    capabilities: {
      diff: true,
      diffFileContents: true,
      inlineComments: true,
      threadReplies: true,
      threadResolution: true,
      reviewVerdicts: ['comment', 'approve', 'request-changes'],
      actions: ['merge', 'close', 'reopen', 'ready', 'draft'],
      mergeMethods: ['merge', 'squash', 'rebase'],
      reviewerRequests: true,
      reviewerCandidates: true,
      labelManagement: true,
    },
    viewerPermissions: {
      actions: ['merge', 'close', 'reopen', 'ready', 'draft'],
      reviewVerdicts: ['comment', 'approve', 'request-changes'],
      comment: true,
      resolveThreads: true,
      requestReviewers: true,
      manageLabels: true,
    },
    ...overrides,
  }
}
