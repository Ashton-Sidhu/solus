import type { AgentId, CommentReadMark, PlanComment, PlanCommentReply } from '@solus/contracts/types'
import { parseUserKey, userKey, type Attribution, type User } from '@solus/contracts/user'

/**
 * Comment and plan-comment threads as the host stores them
 * (plans/012-user-actor-and-activity.md §1 step 4, §2): the wire shape, where
 * who wrote or resolved a message is an `Attribution` stamped by the host.
 *
 * A stored thread may still hold the shape from before plan 012: a `'you'` or
 * `'solus'` label, the agent beside it, and the person a host stamped. Every
 * thread on the Solus API, which has no host user, and a row a host wrote before
 * `adoptHostUser` ran. `readStoredComments` reads both.
 */

/** The key rows written before plan 012 stage 1 held for the host's owner. */
const LEGACY_HOST_OWNER_KEY = 'host-owner'

/** The person a host stamped on a thread before plan 012 stage 4. */
interface LegacyPerson {
  userId: string
  displayName: string
  avatarUrl?: string
}

interface LegacyAgent {
  sessionId: string
  title?: string
  provider: AgentId
}

type LegacyAuthor = 'you' | 'solus'

interface LegacyReply {
  id: string
  author: LegacyAuthor
  authorAgent?: LegacyAgent
  person?: LegacyPerson
  text: string
  createdAt: number
}

type LegacyComment = Omit<PlanComment, 'author' | 'resolvedBy' | 'replies'> & {
  author?: LegacyAuthor
  authorAgent?: LegacyAgent
  person?: LegacyPerson
  resolvedBy?: LegacyAuthor
  resolvedByPerson?: LegacyPerson
  replies?: Array<LegacyReply | PlanCommentReply>
}

/** A stored thread in either shape. */
export type StoredThread = PlanComment | LegacyComment

function isLegacyAuthor(author: LegacyAuthor | Attribution | undefined): author is LegacyAuthor | undefined {
  return author === undefined || author === 'you' || author === 'solus'
}

function isLegacyComment(thread: StoredThread): thread is LegacyComment {
  return isLegacyAuthor(thread.author) || 'person' in thread || 'authorAgent' in thread || 'resolvedByPerson' in thread
}

function isLegacyReply(reply: LegacyReply | PlanCommentReply): reply is LegacyReply {
  return isLegacyAuthor(reply.author)
}

/** The user a stamped person names; the legacy host-owner key is the host's user. */
function userOfPerson(person: LegacyPerson, hostUser: User | null): User {
  if (person.userId === LEGACY_HOST_OWNER_KEY && hostUser) return hostUser
  const user: User = { id: parseUserKey(person.userId), displayName: person.displayName }
  if (person.avatarUrl) user.avatarUrl = person.avatarUrl
  return user
}

/**
 * `'solus'` is the agent that signed it, else Solus itself; `'you'` is the
 * stamped person, else the host's user. Where there is no host user (the Solus
 * API) an unstamped `'you'` was the host's own work, and reads as Solus itself.
 */
function legacyAttribution(author: LegacyAuthor | undefined, agent: LegacyAgent | undefined, person: LegacyPerson | undefined, hostUser: User | null): Attribution {
  if (author === 'solus') {
    if (!agent) return { kind: 'system' }
    const attribution: Attribution = { kind: 'agent', sessionId: agent.sessionId, provider: agent.provider }
    if (agent.title) attribution.title = agent.title
    return attribution
  }
  if (person) return { kind: 'user', user: userOfPerson(person, hostUser) }
  return hostUser ? { kind: 'user', user: hostUser } : { kind: 'system' }
}

function readReply(reply: LegacyReply | PlanCommentReply, hostUser: User | null): PlanCommentReply {
  if (!isLegacyReply(reply)) return reply
  return { id: reply.id, author: legacyAttribution(reply.author, reply.authorAgent, reply.person, hostUser), text: reply.text, createdAt: reply.createdAt }
}

function readMarks(readBy: CommentReadMark[], hostUser: User | null): CommentReadMark[] {
  if (!hostUser) return readBy
  return readBy.map((mark) => (mark.userId === LEGACY_HOST_OWNER_KEY ? { ...mark, userId: userKey(hostUser.id) } : mark))
}

/**
 * Threads as the wire carries them. `hostUser` is who an unstamped `'you'` was;
 * threads already in the wire shape come back as the same objects.
 */
export function readStoredComments(threads: readonly StoredThread[], hostUser: User | null): PlanComment[] {
  return threads.map((thread) => {
    if (!isLegacyComment(thread)) return thread
    const { author, authorAgent, person, resolvedBy, resolvedByPerson, replies, readBy, ...rest } = thread
    const comment: PlanComment = { ...rest, author: isLegacyAuthor(author) ? legacyAttribution(author, authorAgent, person, hostUser) : author }
    if (resolvedBy) comment.resolvedBy = isLegacyAuthor(resolvedBy) ? legacyAttribution(resolvedBy, undefined, resolvedByPerson, hostUser) : resolvedBy
    if (replies) comment.replies = replies.map((reply) => readReply(reply, hostUser))
    if (readBy) comment.readBy = readMarks(readBy, hostUser)
    return comment
  })
}

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

/**
 * The same threads with every message and read mark of `fromKey` moved to `to`
 * (U5): the host's user linking an account, or unlinking it.
 */
export function moveCommentUser(threads: readonly PlanComment[], fromKey: string, to: User): PlanComment[] {
  const toKey = userKey(to.id)
  const move = (attribution: Attribution): Attribution =>
    attribution.kind === 'user' && userKey(attribution.user.id) === fromKey ? { kind: 'user', user: to } : attribution
  return threads.map((thread) => {
    const next: PlanComment = { ...thread }
    if (thread.author) next.author = move(thread.author)
    if (thread.resolvedBy) next.resolvedBy = move(thread.resolvedBy)
    if (thread.replies) next.replies = thread.replies.map((reply) => (reply.author ? { ...reply, author: move(reply.author) } : reply))
    if (thread.readBy) next.readBy = thread.readBy.map((mark) => (mark.userId === fromKey ? { ...mark, userId: toKey } : mark))
    return next
  })
}
