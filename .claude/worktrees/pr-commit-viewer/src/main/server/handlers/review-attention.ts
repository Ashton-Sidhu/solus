import type { PullRequestSummary } from '../../../shared/providers'

/** A current request also covers re-requests: GitHub restores the viewer to
 * requested_reviewers whenever review is requested again. */
export function attachReviewAttention(
  pullRequests: PullRequestSummary[],
  viewer: string,
): PullRequestSummary[] {
  const login = viewer.toLowerCase()
  return pullRequests.map((pr) => {
    if (pr.state !== 'open' || pr.author.toLowerCase() === login) return pr
    const requested = pr.requestedReviewers?.some((reviewer) => reviewer.toLowerCase() === login)
    const assigned = pr.assignees?.some((assignee) => assignee.toLowerCase() === login)
    if (!requested && !assigned) return pr
    return {
      ...pr,
      needsMyReview: true,
      reviewAttention: requested ? 'requested' : 'assigned',
    }
  })
}
