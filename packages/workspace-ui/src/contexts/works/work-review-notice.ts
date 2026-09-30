import { userKey, type UserId } from '@solus/contracts/user'
import type { WorkReview, WorkReviewDecision, WorkReviewsChanged } from '@solus/contracts/work-review'

const DECISION_VERBS = {
  approved: 'approved',
  changes_requested: 'requested changes on',
  commented: 'commented on',
} satisfies Record<WorkReviewDecision, string>

/**
 * The toast a review change earns the reader, or null. A request is news to
 * the people asked; a decision is news to the person who asked for it. The
 * reader's own actions are never news.
 */
export function workReviewNotice(change: WorkReviewsChanged, review: WorkReview | null, self: UserId | null, title: string): string | null {
  if (!self) return null
  const me = userKey(self)
  if (change.by && userKey(change.by.id) === me) return null
  const who = change.by?.displayName ?? 'Someone'
  if (change.change === 'requested') {
    return change.reviewerIds.includes(me) ? `${who} asked you to review “${title}”` : null
  }
  if (change.change === 'decided' && review) {
    const reviewer = review.reviewers.find((candidate) => change.reviewerIds.includes(candidate.reviewerId))
    if (!reviewer?.decision || !reviewer.requestedBy || userKey(reviewer.requestedBy.id) !== me) return null
    return `${who} ${DECISION_VERBS[reviewer.decision]} “${title}”`
  }
  return null
}
