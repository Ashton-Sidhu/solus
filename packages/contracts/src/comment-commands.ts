/**
 * Comment threads on a shared work — who may do what
 * (docs/plans/multiplayer-comments.md). A client never writes the whole sidecar:
 * it sends one command, the host stamps who did it and applies it to the threads
 * it holds, so two people commenting at once cannot overwrite each other. The
 * reducer lives here, beside the schema, because the host, the Lab, and the demo
 * backend must agree on one answer to "may this person do this to that thread".
 */

import { z } from 'zod'
import type { TurnAuthor } from './presence'
import type { PlanComment, PlanCommentReply } from './types'

const commentIdSchema = z.string().min(1)
const commentPinSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })

/** A new thread as the client writes it: what it is on and what it says. The host
 *  adds who and when. */
export const newWorkCommentSchema = z.object({
  id: commentIdSchema,
  selectedText: z.string(),
  comment: z.string().min(1),
  textOffset: z.number().int().min(0).optional(),
  nodeId: z.string().min(1).optional(),
  edgeId: z.string().min(1).optional(),
  pin: commentPinSchema.optional(),
  externalThreadId: z.string().min(1).optional(),
})
export type NewWorkComment = z.infer<typeof newWorkCommentSchema>

export const workCommentCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), comment: newWorkCommentSchema }),
  z.object({ kind: z.literal('edit'), commentId: commentIdSchema, text: z.string().min(1) }),
  z.object({ kind: z.literal('delete'), commentId: commentIdSchema }),
  z.object({ kind: z.literal('reply'), commentId: commentIdSchema, reply: z.object({ id: commentIdSchema, text: z.string().min(1) }) }),
  z.object({ kind: z.literal('resolve'), commentId: commentIdSchema, resolved: z.boolean() }),
  /** The caller's own read mark. The one command a viewer may send. */
  z.object({ kind: z.literal('read'), commentId: commentIdSchema }),
  /** Every open thread at once, as when a round of feedback is handed to an agent. */
  z.object({ kind: z.literal('resolve-open') }),
])
export type WorkCommentCommand = z.infer<typeof workCommentCommandSchema>

/** Who is applying a command, as the host knows them. */
export interface CommentActor {
  /** The host-stamped identity; null for the host's own work, which signs nothing. */
  person: TurnAuthor | null
  /** May edit and delete other people's threads: the work's owner or a host admin. */
  canModerate: boolean
  now: number
}

export const COMMENT_COMMAND_ERROR_CODES = ['FORBIDDEN', 'NOT_FOUND', 'CONFLICT'] as const
export type CommentCommandErrorCode = (typeof COMMENT_COMMAND_ERROR_CODES)[number]

export class CommentCommandError extends Error {
  constructor(readonly code: CommentCommandErrorCode, message: string) {
    super(message)
    this.name = 'CommentCommandError'
  }
}

/**
 * A thread is the author's: the person who wrote it, or — for a thread written
 * before works had people, and for the host's own — whoever moderates the work.
 * An agent's thread belongs to nobody in particular, so an editor may tidy it.
 */
export function mayChangeThread(comment: PlanComment, actor: CommentActor): boolean {
  if (actor.canModerate) return true
  if ((comment.author ?? 'you') === 'solus') return true
  return !!comment.person && !!actor.person && comment.person.userId === actor.person.userId
}

/**
 * Apply one command to a work's threads and return the new list. Threads that
 * the command does not touch are returned as the same objects, so a client that
 * reconciles by identity moves nothing it does not have to.
 */
export function applyCommentCommand(comments: readonly PlanComment[], command: WorkCommentCommand, actor: CommentActor): PlanComment[] {
  if (command.kind === 'add') {
    if (comments.some((c) => c.id === command.comment.id)) throw new CommentCommandError('CONFLICT', `Thread ${command.comment.id} already exists.`)
    const created: PlanComment = { ...command.comment, author: 'you', createdAt: actor.now }
    if (actor.person) {
      created.person = actor.person
      created.readBy = [{ userId: actor.person.userId, readAt: actor.now }]
    } else {
      created.readAt = actor.now
    }
    return [...comments, created]
  }
  if (command.kind === 'resolve-open') return comments.map((c) => (c.resolvedAt === undefined ? resolved(c, actor) : c))
  const index = comments.findIndex((c) => c.id === command.commentId)
  if (index === -1) throw new CommentCommandError('NOT_FOUND', `No thread ${command.commentId}.`)
  const current = comments[index]!
  const next = [...comments]
  switch (command.kind) {
    case 'edit':
      if (!mayChangeThread(current, actor)) throw new CommentCommandError('FORBIDDEN', 'Only the person who wrote a comment may edit it.')
      next[index] = { ...current, comment: command.text }
      return next
    case 'delete':
      if (!mayChangeThread(current, actor)) throw new CommentCommandError('FORBIDDEN', 'Only the person who wrote a comment may delete it.')
      next.splice(index, 1)
      return next
    case 'reply': {
      if (current.replies?.some((r) => r.id === command.reply.id)) throw new CommentCommandError('CONFLICT', `Reply ${command.reply.id} already exists.`)
      const reply: PlanCommentReply = { id: command.reply.id, author: 'you', text: command.reply.text, createdAt: actor.now }
      if (actor.person) reply.person = actor.person
      // Answering a thread is proof of having read it to this moment.
      next[index] = { ...withReadMark(current, actor), replies: [...(current.replies ?? []), reply] }
      return next
    }
    case 'resolve': {
      if (command.resolved) {
        next[index] = resolved(current, actor)
      } else {
        const reopened: PlanComment = { ...current }
        delete reopened.resolvedAt
        delete reopened.resolvedBy
        delete reopened.resolvedByPerson
        next[index] = reopened
      }
      return next
    }
    case 'read':
      next[index] = withReadMark(current, actor)
      return next
  }
}

/** The actor's own read mark, now: their entry in `readBy`, or the single-reader
 *  `readAt` when the host itself is reading. */
function withReadMark(comment: PlanComment, actor: CommentActor): PlanComment {
  if (!actor.person) return { ...comment, readAt: actor.now }
  const userId = actor.person.userId
  const others = (comment.readBy ?? []).filter((mark) => mark.userId !== userId)
  return { ...comment, readBy: [...others, { userId, readAt: actor.now }] }
}

function resolved(comment: PlanComment, actor: CommentActor): PlanComment {
  const next: PlanComment = { ...comment, resolvedAt: actor.now, resolvedBy: 'you' }
  if (actor.person) next.resolvedByPerson = actor.person
  else delete next.resolvedByPerson
  return next
}
