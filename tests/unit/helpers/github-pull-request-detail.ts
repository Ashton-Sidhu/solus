/** What GitHub's GraphQL answers for `PullRequestDetail`, for one open pull
 *  request in `acme/app`. Tests change the parts they are about. */
export interface DetailAnswerOptions {
  number?: number
  viewerPermission?: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ'
  mergeStateStatus?: string
  /** Null when the base branch is gone. */
  baseRef?: {
    branchProtectionRule: { requiresLinearHistory: boolean; requiredApprovingReviewCount: number | null } | null
    rules: { nodes: Array<{ type: string; parameters: { requiredApprovingReviewCount?: number; allowedMergeMethods?: string[] } | null }> }
  } | null
  commits?: { hasNextPage: boolean; endCursor: string | null; oids: string[] }
}

export function githubPullRequestDetailAnswer(options: DetailAnswerOptions = {}) {
  const commits = options.commits ?? { hasNextPage: false, endCursor: null, oids: ['c1'] }
  return {
    viewer: { login: 'sidhu' },
    repository: {
      viewerPermission: options.viewerPermission ?? 'WRITE',
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      autoMergeAllowed: true,
      viewerDefaultMergeMethod: 'MERGE',
      pullRequest: {
        number: options.number ?? 65,
        url: `https://github.com/acme/app/pull/${options.number ?? 65}`,
        title: 'Consolidate pull request state',
        body: 'Body',
        state: 'OPEN',
        isDraft: false,
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-02T00:00:00Z',
        author: { login: 'octocat', avatarUrl: 'https://avatars.test/octocat' },
        headRefOid: 'head-sha',
        baseRefOid: 'base-sha',
        headRefName: 'feature',
        baseRefName: 'main',
        additions: 3,
        deletions: 1,
        changedFiles: 2,
        mergeable: 'MERGEABLE',
        mergeStateStatus: options.mergeStateStatus ?? 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        reviews: { totalCount: 2 },
        autoMergeRequest: null,
        baseRepository: { nameWithOwner: 'acme/app' },
        headRepository: { nameWithOwner: 'acme/app', name: 'app', owner: { login: 'acme' } },
        labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
        assignees: { nodes: [{ login: 'octocat' }] },
        reviewRequests: { nodes: [{ requestedReviewer: { login: 'hubot', avatarUrl: 'https://avatars.test/hubot' } }] },
        latestReviews: {
          nodes: [
            { state: 'COMMENTED', author: { login: 'monalisa', avatarUrl: 'https://avatars.test/monalisa' } },
            { state: 'COMMENTED', author: { login: 'linus' } },
          ],
        },
        // Mona approved before her later comment; the approval stands.
        latestOpinionatedReviews: {
          nodes: [{ state: 'APPROVED', author: { login: 'monalisa', avatarUrl: 'https://avatars.test/monalisa' } }],
        },
        commits: {
          pageInfo: { hasNextPage: commits.hasNextPage, endCursor: commits.endCursor },
          nodes: commits.oids.map((oid) => ({
            commit: {
              oid,
              message: `Commit ${oid}\n\nThe body.`,
              committedDate: '2026-08-01T12:00:00Z',
              author: { name: 'Octo Cat', date: '2026-08-01T11:00:00Z', user: { login: 'octocat' } },
            },
          })),
        },
        baseRef: options.baseRef === undefined
          ? { branchProtectionRule: null, rules: { nodes: [] } }
          : options.baseRef,
      },
    },
  }
}
