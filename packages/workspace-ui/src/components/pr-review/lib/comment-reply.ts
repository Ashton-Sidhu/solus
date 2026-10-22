import type { PrCommentActivityItem } from '@solus/contracts/providers'

/**
 * A reply to a top-level pull request comment. The host's conversation is
 * flat — an issue comment has no parent — so a reply is a new comment that
 * quotes what it answers and mentions its author, the way the host's own
 * "Quote reply" writes one. The quote is what makes it read as a reply on the
 * host page too, not only in Solus.
 */

/** The reply's target, enough to name and quote it. */
export interface CommentReplyTarget {
  id: string
  author: string
  body: string
}

export function commentReplyTarget(comment: PrCommentActivityItem): CommentReplyTarget {
  return { id: comment.id, author: comment.author, body: comment.body }
}

/** One line of the quoted comment for the chip over the composer. */
export function replyPreviewText(target: CommentReplyTarget, maxLength = 80): string {
  const line = target.body
    .split('\n')
    .map((part) => part.replace(/^[>\s#*-]+/, '').trim())
    .find((part) => part.length > 0) ?? ''
  if (line.length <= maxLength) return line
  return `${line.slice(0, maxLength - 1).trimEnd()}…`
}

/** The comment that is posted: the target quoted, then the mention and the reply. */
export function quotedReplyBody(target: CommentReplyTarget, reply: string): string {
  const quoted = target.body.trim()
  const quote = quoted.length > 0
    ? quoted.split('\n').map((line) => (line.length > 0 ? `> ${line}` : '>')).join('\n')
    : ''
  const mention = `@${target.author}`
  const answer = reply.trim()
  const mentioned = new RegExp(`(^|\\s)${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(answer)
  const body = mentioned ? answer : `${mention} ${answer}`
  return quote.length > 0 ? `${quote}\n\n${body}` : body
}
