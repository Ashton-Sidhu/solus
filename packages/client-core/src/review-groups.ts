import type { PrCommentActivityItem, PrConversationItem, ReviewThread } from '@solus/contracts/providers'

/**
 * How a pull request's inline threads hang from its reviews. The host shows
 * a review once — its verdict and body — with the threads it was submitted
 * with nested under it; a thread left outside a review stands alone. Both
 * timelines (the workspace's and the phone's) read the same grouping, so a
 * thread is never shown twice or lost between them.
 */

export interface ReviewThreadGroups {
  /** Threads keyed by the id of the review they were submitted with, for
   *  reviews that are in the conversation. */
  byReview: Map<string, ReviewThread[]>
  /** Threads with no review in the conversation to hang from. */
  standalone: ReviewThread[]
}

export function groupThreadsByReview(
  conversation: readonly PrConversationItem[],
  threads: readonly ReviewThread[],
): ReviewThreadGroups {
  const reviewIds = new Set<string>()
  for (const item of conversation) if (item.kind === 'review') reviewIds.add(item.id)
  const byReview = new Map<string, ReviewThread[]>()
  const standalone: ReviewThread[] = []
  for (const thread of threads) {
    const reviewId = thread.comments[0]?.reviewId
    if (!reviewId || !reviewIds.has(reviewId)) {
      standalone.push(thread)
      continue
    }
    const group = byReview.get(reviewId)
    if (group) group.push(thread)
    else byReview.set(reviewId, [thread])
  }
  return { byReview, standalone }
}

/**
 * Whether a review earns a row of its own. A verdict is always an event; a
 * comment-only review is one when it says something or owns a thread. The
 * host creates a bodiless comment-only review for every lone inline comment,
 * and that review is nothing beside the thread itself.
 */
export function reviewIsEvent(review: PrCommentActivityItem, threads: readonly ReviewThread[]): boolean {
  if (review.kind !== 'review') return true
  if (review.reviewState && review.reviewState !== 'COMMENTED') return true
  if (threads.length > 0) return true
  return review.body.replace(/<!--[\s\S]*?-->/g, '').trim().length > 0
}
