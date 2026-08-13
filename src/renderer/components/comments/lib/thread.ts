import type { CommentAuthor, PlanComment, PlanCommentReply } from '../../../../shared/types'

/** Every author read goes through here: comments written before threads had
 *  authors have no field, and they were all written by the person reading. */
export function commentAuthor(c: Pick<PlanComment, 'author'>): CommentAuthor {
  return c.author ?? 'you'
}

export function isResolved(c: Pick<PlanComment, 'resolvedAt'>): boolean {
  return c.resolvedAt !== undefined
}

/**
 * Unread is derived, never stored: a thread is unread when Solus has said
 * something in it since the reader last opened it. A thread the reader wrote
 * and nobody answered is not unread — it would be unread of yourself.
 */
export function isUnread(c: PlanComment): boolean {
  const readAt = c.readAt ?? 0
  const solusMessages = [
    ...(commentAuthor(c) === 'solus' ? [c.createdAt ?? 0] : []),
    ...(c.replies ?? []).filter((r) => r.author === 'solus').map((r) => r.createdAt),
  ]
  return solusMessages.some((at) => at > readAt)
}

export function openThreads(comments: PlanComment[]): PlanComment[] {
  return comments.filter((c) => !isResolved(c))
}

export function resolvedThreads(comments: PlanComment[]): PlanComment[] {
  return comments.filter(isResolved)
}

/**
 * Two replies are shown, then "n earlier replies" — a thread in the margin is
 * a summary of a conversation, not the conversation.
 */
export interface VisibleReplies {
  earlierCount: number
  shown: PlanCommentReply[]
}

export function visibleReplies(c: PlanComment): VisibleReplies {
  const replies = c.replies ?? []
  if (replies.length <= 2) return { earlierCount: 0, shown: replies }
  return { earlierCount: replies.length - 2, shown: replies.slice(-2) }
}

/** Author name omitted on a reply that repeats the previous speaker. */
export function showsAuthor(shown: PlanCommentReply[], index: number): boolean {
  if (index === 0) return true
  return shown[index].author !== shown[index - 1].author
}

export function authorName(author: CommentAuthor): string {
  return author === 'solus' ? 'Solus' : 'You'
}

/** The name on a thread message. An agent-written one names the agent that wrote
 *  it — "Solus" cannot say WHICH agent, and several can be reviewing at once. */
export function authorLabel(message: Pick<PlanComment, 'author' | 'authorAgent'>): string {
  const author = commentAuthor(message)
  if (author !== 'solus') return authorName(author)
  return message.authorAgent?.title || 'Solus'
}

/**
 * A thread in Solus has exactly two possible voices: you, and the agent. You
 * get a terracotta initials circle — the hue that already means "you" on every
 * reply affordance in the document — and Solus gets a ✦ in place of a circle,
 * which tells the two apart without anyone reading a name.
 *
 * (The design's chart-4/chart-5 avatars belong to a document with several
 * human authors. Hashing a name to pick between them here would only ever
 * produce one arbitrary colour for the one human in the room.)
 */
export function authorInitials(author: CommentAuthor): string {
  return author === 'solus' ? '✦' : 'You'
}
