import type { PlanComment } from '@solus/contracts/types'
import type { Attribution } from '@solus/contracts/user'

/**
 * Comment and plan-comment threads as the host stores them
 * (plans/012-user-actor-and-activity.md §1 step 4, §2): the wire shape, where
 * who wrote or resolved a message is an `Attribution` stamped by the host.
 */

/**
 * Threads a client wrote whole (a plan's annotations) with every message it has
 * not had stamped yet stamped as `by`: a new thread, a new reply, and a thread
 * it resolved. A client never names itself; an existing message keeps the
 * author the host gave it.
 */
export function stampComments(threads: readonly PlanComment[], by: Attribution): PlanComment[] {
  return threads.map((thread) => {
    const needsStamp = !thread.author
      || (thread.resolvedAt !== undefined && !thread.resolvedBy)
      || (thread.replies?.some((reply) => !reply.author) ?? false)
    if (!needsStamp) return thread
    const stamped: PlanComment = { ...thread, author: thread.author ?? by }
    if (stamped.resolvedAt !== undefined) stamped.resolvedBy ??= by
    if (thread.replies) stamped.replies = thread.replies.map((reply) => (reply.author ? reply : { ...reply, author: by }))
    return stamped
  })
}
