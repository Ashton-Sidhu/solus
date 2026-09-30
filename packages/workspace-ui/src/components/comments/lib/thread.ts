import type { PlanComment, PlanCommentReply } from '@solus/contracts/types'
import type { DocCommentThread } from '@solus/contracts/work-comments'
import { attributionLabel, sameUser, userKey, type Attribution, type User, type UserId } from '@solus/contracts/user'

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

/**
 * Who reads a comment surface (docs/plans/multiplayer-comments.md): their user
 * on the work's host, null while they do not know who they are. A plan has one
 * reader, so every person on it is the reader.
 */
export interface CommentReader {
  userId: UserId | null
  isSingleReader: boolean
}

/** The one reader a plan has: every person's message is theirs. */
export const SINGLE_READER: CommentReader = { userId: null, isSingleReader: true }

type ThreadMessage = Pick<PlanComment, 'author'>

/** A message no person wrote: an agent's, an automation's, or Solus's own. It signs itself with a spark. */
export function isAgentMessage(message: ThreadMessage): boolean {
  return !!message.author && message.author.kind !== 'user'
}

/**
 * Whether a person's message is the reader's own. A message the host has not
 * stamped yet is the one the reader just wrote. A known reader owns the messages
 * that name them (`sameUser`); a plan's one reader owns every person's message;
 * a reader who does not know who they are yet owns none: a stranger's name on a
 * thread is right, and the reader's own name on their own thread is merely redundant.
 */
export function isOwnMessage(message: ThreadMessage, reader: CommentReader = SINGLE_READER): boolean {
  const author = message.author
  if (!author) return true
  if (author.kind !== 'user') return false
  if (reader.isSingleReader) return true
  return !!reader.userId && sameUser(author.user.id, reader.userId)
}

/** The person to show beside a message: someone else on the work. Null for the
 *  reader's own messages and for an agent's, which signs itself with a spark. */
export function messageUser(message: ThreadMessage, reader: CommentReader = SINGLE_READER): User | null {
  const author = message.author
  if (author?.kind !== 'user' || isOwnMessage(message, reader)) return null
  return author.user
}

/**
 * Who may edit or delete a thread from this client: its author, a moderator of
 * the work, or anyone for an agent's or an automation's note. The host holds the
 * same rule (`mayChangeThread`); this only decides whether to offer the verbs.
 */
export function canChangeThread(comment: ThreadMessage, viewer: CommentReader & { canModerate: boolean }): boolean {
  if (viewer.canModerate) return true
  const kind = comment.author?.kind
  if (kind === 'agent' || kind === 'automation') return true
  return kind === 'user' && isOwnMessage(comment, viewer)
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
export function isUnread(c: PlanComment, reader: CommentReader = SINGLE_READER): boolean {
  const selfKey = reader.userId ? userKey(reader.userId) : null
  const readAt = Math.max(c.readAt ?? 0, ...(c.readBy ?? []).filter((mark) => mark.userId === selfKey).map((mark) => mark.readAt))
  const fromOthers = (message: ThreadMessage): boolean => {
    if (isAgentMessage(message)) return true
    // Another person's message counts once the reader knows who they are;
    // until then nobody's words can be told from the reader's own.
    return !reader.isSingleReader && !!reader.userId && !isOwnMessage(message, reader)
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
  return speakerKey(shown[index].author) !== speakerKey(shown[index - 1].author)
}

/** One key per speaker: a person, an agent's session, an automation. */
function speakerKey(author: Attribution | undefined): string {
  switch (author?.kind) {
    case undefined: return 'unstamped'
    case 'user': return `user:${userKey(author.user.id)}`
    case 'agent': return `agent:${author.sessionId}`
    case 'automation': return `automation:${author.automationId}`
    case 'upstream': return `upstream:${author.provider}`
    case 'system': return 'system'
  }
}

/** The name on a thread message: the agent that wrote it, the person the host
 *  stamped when they are not the reader, or "You". "Solus" alone cannot say
 *  WHICH agent, and several can be reviewing at once. */
export function authorLabel(message: ThreadMessage, reader: CommentReader = SINGLE_READER): string {
  if (message.author && isAgentMessage(message)) return attributionLabel(message.author)
  return messageUser(message, reader)?.displayName ?? 'You'
}
