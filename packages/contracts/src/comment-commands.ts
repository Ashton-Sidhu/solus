/**
 * Comment threads on a shared work — who may do what
 * (docs/plans/multiplayer-comments.md). A client never writes the whole sidecar:
 * it sends one command, the host stamps who did it and applies it to the threads
 * it holds, so two people commenting at once cannot overwrite each other. The
 * reducer lives here, beside the schema, because the host, the Lab, and the demo
 * backend must agree on one answer to "may this person do this to that thread".
 */

import { z } from 'zod'
import type { PlanComment, PlanCommentReply, WorkAnnotations, WorkMark } from './types'
import { TURN_FLAG_KINDS } from './observability-types'
import { sameUser, userKey, type Attribution } from './user'

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
  /** The caller's own mark on an Insights report; it replaces their last one.
   *  A mark is a reaction like a comment, so a commenter may set it. */
  z.object({ kind: z.literal('mark'), mark: z.object({ kind: z.enum(TURN_FLAG_KINDS), note: z.string() }) }),
  /** Clear the caller's own mark. */
  z.object({ kind: z.literal('unmark') }),
])
export type WorkCommentCommand = z.infer<typeof workCommentCommandSchema>
type ThreadCommand = Exclude<WorkCommentCommand, { kind: 'mark' | 'unmark' }>

/** Who is applying a command, as the host knows them. */
export interface CommentActor {
  /** Who the host records for this command: the admitted actor's attribution
   *  (`attributionOf` on the host). The host's own work is `system`. */
  by: Attribution
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
 * A thread is the author's: the person who wrote it, or — for the host's own
 * and anything else no person wrote — whoever moderates the work. An agent's or
 * an automation's thread belongs to nobody in particular, so an editor may tidy it.
 */
export function mayChangeThread(comment: PlanComment, actor: CommentActor): boolean {
  if (actor.canModerate) return true
  const author = comment.author
  if (author?.kind === 'agent' || author?.kind === 'automation') return true
  return author?.kind === 'user' && actor.by.kind === 'user' && sameUser(author.user.id, actor.by.user.id)
}

/** The key of the person a command is for; null when no person applies it. */
function readerKey(actor: CommentActor): string | null {
  return actor.by.kind === 'user' ? userKey(actor.by.user.id) : null
}

/**
 * Apply one command to a work's annotations: a mark command changes the
 * caller's mark, any other command the threads. The host, the Lab, and the
 * demo backend all apply commands through this one function.
 */
export function applyWorkCommand(annotations: WorkAnnotations, command: WorkCommentCommand, actor: CommentActor): WorkAnnotations {
  if (command.kind === 'mark' || command.kind === 'unmark') {
    if (actor.by.kind !== 'user') throw new CommentCommandError('FORBIDDEN', 'Only a person may mark a report.')
    const by = actor.by.user
    const others = (annotations.marks ?? []).filter((mark) => !sameUser(mark.by.id, by.id))
    const marks: WorkMark[] = command.kind === 'mark'
      ? [...others, { by, kind: command.mark.kind, note: command.mark.note.trim(), updatedAt: actor.now }]
      : others
    return { ...annotations, marks }
  }
  return { ...annotations, comments: applyCommentCommand(annotations.comments, command, actor) }
}

/**
 * Apply one command to a work's threads and return the new list. Threads that
 * the command does not touch are returned as the same objects, so a client that
 * reconciles by identity moves nothing it does not have to.
 */
export function applyCommentCommand(comments: readonly PlanComment[], command: ThreadCommand, actor: CommentActor): PlanComment[] {
  if (command.kind === 'add') {
    if (comments.some((c) => c.id === command.comment.id)) throw new CommentCommandError('CONFLICT', `Thread ${command.comment.id} already exists.`)
    const created: PlanComment = { ...command.comment, author: actor.by, createdAt: actor.now }
    const reader = readerKey(actor)
    if (reader) created.readBy = [{ userId: reader, readAt: actor.now }]
    else created.readAt = actor.now
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
      const reply: PlanCommentReply = { id: command.reply.id, author: actor.by, text: command.reply.text, createdAt: actor.now }
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
  const userId = readerKey(actor)
  if (!userId) return { ...comment, readAt: actor.now }
  const others = (comment.readBy ?? []).filter((mark) => mark.userId !== userId)
  return { ...comment, readBy: [...others, { userId, readAt: actor.now }] }
}

function resolved(comment: PlanComment, actor: CommentActor): PlanComment {
  return { ...comment, resolvedAt: actor.now, resolvedBy: actor.by }
}
