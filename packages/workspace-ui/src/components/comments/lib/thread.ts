import type { CommentAuthor, PlanComment, PlanCommentReply } from '@solus/contracts/types'
import type { TurnAuthor } from '@solus/contracts/presence'
import type { DocCommentThread } from '@solus/contracts/work-comments'
import { initialsFor } from '../../ui/list-page/list-page'
import type { PresencePerson, SelfIds } from '../../presence/lib/presence-people'

/**
 * One card in the comments rail. A document with a linked external copy has
 * two kinds of conversation on it — the private Solus threads and the ones
 * that live in the provider — and they share the single margin, so the rail
 * places both the same way and each card says where it lives.
 */
export type RailThread =
  | { kind: 'local'; id: string; comment: PlanComment }
  | { kind: 'external'; id: string; thread: DocCommentThread }

export function railThreads(comments: PlanComment[], external: DocCommentThread[]): RailThread[] {
  return [
    ...comments.map((comment) => ({ kind: 'local' as const, id: comment.id, comment })),
    ...external.map((thread) => ({ kind: 'external' as const, id: thread.id, thread })),
  ]
}

/** Every author read goes through here: comments written before threads had
 *  authors have no field, and they were all written by the person reading. */
export function commentAuthor(c: Pick<PlanComment, 'author'>): CommentAuthor {
  return c.author ?? 'you'
}

type ThreadMessage = Pick<PlanComment, 'author' | 'authorAgent' | 'person'>

/**
 * Whether a human message is the reader's own (docs/plans/multiplayer-comments.md).
 * A message with no person was written before works had people, by the one
 * reader there was; a message with a person is the reader's when that person is
 * one of the ids the reader holds on the host. An unknown reader (no ids yet)
 * owns only the anonymous ones: a stranger's name on a thread is right, and the
 * reader's own name on their own thread is merely redundant.
 */
export function isOwnMessage(message: ThreadMessage, self: SelfIds = []): boolean {
  if (commentAuthor(message) === 'solus') return false
  if (!message.person) return true
  return self.includes(message.person.userId)
}

/** The person to show beside a message: someone else on the work. Null for the
 *  reader's own messages and for an agent's, which signs itself with a spark. */
export function messagePerson(message: ThreadMessage, self: SelfIds = []): PresencePerson | null {
  if (!message.person || isOwnMessage(message, self)) return null
  return personFrom(message.person)
}

export function personFrom(author: TurnAuthor): PresencePerson {
  const person: PresencePerson = {
    userId: author.userId,
    displayName: author.displayName,
    initials: initialsFor(author.displayName),
    colorIndex: author.colorIndex,
    isComposing: false,
    deviceCount: 1,
    clientIds: [],
  }
  if (author.avatarUrl) person.avatarUrl = author.avatarUrl
  return person
}

/**
 * Who may edit or delete a thread from this client: its author, a moderator of
 * the work, or anyone for an agent's note. The host holds the same rule
 * (`mayChangeThread`); this only decides whether to offer the verbs.
 */
export function canChangeThread(comment: ThreadMessage, viewer: { selfUserIds: SelfIds; canModerate: boolean }): boolean {
  if (viewer.canModerate) return true
  if (commentAuthor(comment) === 'solus') return true
  return isOwnMessage(comment, viewer.selfUserIds)
}

export function isResolved(c: Pick<PlanComment, 'resolvedAt'>): boolean {
  return c.resolvedAt !== undefined
}

/**
 * Unread is derived, never stored: a thread is unread when somebody else — an
 * agent, or another person on the work — has said something in it since the
 * reader last opened it. A thread the reader wrote and nobody answered is not
 * unread — it would be unread of yourself. The reader's mark is their own entry
 * in `readBy`, or the single-reader `readAt` a plan keeps.
 */
export function isUnread(c: PlanComment, self: SelfIds = []): boolean {
  const readAt = Math.max(c.readAt ?? 0, ...(c.readBy ?? []).filter((mark) => self.includes(mark.userId)).map((mark) => mark.readAt))
  const fromOthers = (message: ThreadMessage): boolean => {
    if (commentAuthor(message) === 'solus') return true
    // Another person's message counts once the reader knows who they are;
    // until then nobody's words can be told from the reader's own.
    return !!message.person && self.length > 0 && !self.includes(message.person.userId)
  }
  const messages = [
    ...(fromOthers(c) ? [c.createdAt ?? 0] : []),
    ...(c.replies ?? []).filter(fromOthers).map((r) => r.createdAt),
  ]
  return messages.some((at) => at > readAt)
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
  const current = shown[index]
  const previous = shown[index - 1]
  return current.author !== previous.author || current.person?.userId !== previous.person?.userId
}

/** The name on a thread message: the agent that wrote it, the person the host
 *  stamped when they are not the reader, or "You". "Solus" alone cannot say
 *  WHICH agent, and several can be reviewing at once. */
export function authorLabel(message: ThreadMessage, self: SelfIds = []): string {
  if (commentAuthor(message) === 'solus') return message.authorAgent?.title || 'Solus'
  return messagePerson(message, self)?.displayName ?? 'You'
}
