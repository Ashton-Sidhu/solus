import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { CommentPin, CommentReadMark, PlanComment, PlanCommentReply } from '@solus/contracts/types'
import { attributionSchema, sameUser, userKey, type Attribution } from '@solus/contracts/user'
import { applyCommentCommand, CommentCommandError, type CommentActor, type WorkCommentCommand } from '@solus/contracts/comment-commands'
import type { Db } from '../../db/database'
import { hostUserKey } from '../../host/host-user'
import { planAnnotations } from '../../plans/schema'
import { tasks } from '../tasks/schema'
import { works } from '../works/schema'
import { commentThreads } from './schema'

/**
 * The comment threads of a task, a work, or a plan (`comment_threads`,
 * plans/029-fresh-database-baseline.md §5.2). Every write names one subject
 * and one thread, or is a batch checked against the state it was read at; the
 * table is never rewritten whole, so one person's edit is one row and a stale
 * copy cannot delete a thread it never saw.
 *
 * A work's and a plan's threads are `PlanComment`s on the wire; the reducer in
 * `@solus/contracts/comment-commands` decides what a command does to one, and
 * `applyThreadCommand` runs it against the one row with a compare-and-set on
 * the thread's version. A task's comments are `TaskComment`s; `task-store.ts`
 * projects them from the same rows.
 */

export type ThreadSubjectKind = 'task' | 'work' | 'plan'

export interface ThreadSubject {
  organizationId: string
  kind: ThreadSubjectKind
  /** The task id, the work id, or the plan's session id. */
  id: string
  /** The plan's tool use id; absent on a task or a work. */
  part?: string
}

/** The upstream author of an external comment: a name, never a local user. */
export interface ExternalAuthor {
  kind: 'external'
  name: string | null
}

export type ThreadAuthor = Attribution | ExternalAuthor
export type ThreadDeliveryState = 'private' | 'pending' | 'sent'

/** The upstream identity of a comment: the target it is unique under, and its id there. */
export interface ExternalThreadIdentity {
  scope: string
  id: string
}

const replySchema: z.ZodType<PlanCommentReply> = z.object({
  id: z.string(),
  author: attributionSchema.optional(),
  text: z.string(),
  createdAt: z.number(),
})

const readMarkSchema: z.ZodType<CommentReadMark> = z.object({ userId: z.string(), readAt: z.number() })
const pinSchema: z.ZodType<CommentPin> = z.object({ x: z.number(), y: z.number() })

/** The review payload of a thread: everything of a `PlanComment` that is not a column. */
const threadReviewSchema = z.object({
  selectedText: z.string().optional(),
  textOffset: z.number().optional(),
  pin: pinSchema.optional(),
  externalThreadId: z.string().optional(),
  googleThreadId: z.string().optional(),
  resolvedAt: z.number().optional(),
  resolvedBy: attributionSchema.optional(),
  replies: z.array(replySchema).optional(),
  readAt: z.number().optional(),
  readBy: z.array(readMarkSchema).optional(),
})
export type ThreadReview = z.infer<typeof threadReviewSchema>

const threadAuthorSchema: z.ZodType<ThreadAuthor> = z.union([
  attributionSchema,
  z.object({ kind: z.literal('external'), name: z.string().nullable() }),
])

const threadRowSchema = z.object({
  thread_id: z.string(),
  body: z.string(),
  created_by: z.string(),
  author: z.string(),
  source: z.enum(['local', 'external']),
  origin_session_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  position: z.number(),
  version: z.number(),
  delivery_state: z.enum(['private', 'pending', 'sent']),
  external_scope: z.string().nullable(),
  external_id: z.string().nullable(),
  review: z.string(),
})
type ThreadRow = z.infer<typeof threadRowSchema>

export interface ThreadRecord {
  threadId: string
  body: string
  createdBy: string
  author: ThreadAuthor
  source: 'local' | 'external'
  originSessionId: string | null
  createdAt: number
  updatedAt: number
  position: number
  version: number
  deliveryState: ThreadDeliveryState
  external: ExternalThreadIdentity | null
  review: ThreadReview
}

export interface NewThread {
  threadId: string
  body: string
  author: ThreadAuthor
  /** Who made the row; `creatorKeyOf(author)` when the author is who acted. */
  createdBy: string
  source?: 'local' | 'external'
  originSessionId?: string | null
  createdAt?: number
  deliveryState?: ThreadDeliveryState
  external?: ExternalThreadIdentity | null
  review?: ThreadReview
}

const THREAD_COLUMNS = sql.raw('thread_id, body, created_by, author, source, origin_session_id, created_at, updated_at, position, version, delivery_state, external_scope, external_id, review')

/**
 * The user id a thread is created by (plans/029 decision 2): the acting person,
 * the person an agent or an automation acted for, else the host's user, as a
 * task or a work that no person made is the host's user's.
 */
export function creatorKeyOf(by: Attribution): string {
  if (by.kind === 'user') return userKey(by.user.id)
  if ((by.kind === 'agent' || by.kind === 'automation') && by.for) return userKey(by.for.id)
  return hostUserKey()
}

function subjectClause(subject: ThreadSubject): SQL {
  return sql`organization_id = ${subject.organizationId} AND subject_kind = ${subject.kind} AND subject_id = ${subject.id} AND subject_part = ${subject.part ?? ''}`
}

/** The author as stored: a link or unlink of the host's account rewrites the rows (`host-user-rows.ts`), so nothing is followed on read. */
function readAuthor(json: string): ThreadAuthor {
  return threadAuthorSchema.parse(JSON.parse(json))
}

function recordFromRow(row: ThreadRow): ThreadRecord {
  return {
    threadId: row.thread_id,
    body: row.body,
    createdBy: row.created_by,
    author: readAuthor(row.author),
    source: row.source,
    originSessionId: row.origin_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    position: row.position,
    version: row.version,
    deliveryState: row.delivery_state,
    external: row.external_scope !== null && row.external_id !== null ? { scope: row.external_scope, id: row.external_id } : null,
    review: threadReviewSchema.parse(JSON.parse(row.review)),
  }
}

/** A subject's threads in their reading order: a task's by time, a work's or a plan's by position. */
export async function readThreads(db: Db, subject: ThreadSubject): Promise<ThreadRecord[]> {
  const order = subject.kind === 'task' ? sql`created_at, thread_id` : sql`position, thread_id`
  const rows = threadRowSchema.array().parse(await db.all(sql`
    SELECT ${THREAD_COLUMNS} FROM ${commentThreads} WHERE ${subjectClause(subject)} ORDER BY ${order}
  `))
  return rows.map(recordFromRow)
}

export async function readThread(db: Db, subject: ThreadSubject, threadId: string): Promise<ThreadRecord | undefined> {
  const row = threadRowSchema.nullish().parse(await db.get(sql`
    SELECT ${THREAD_COLUMNS} FROM ${commentThreads} WHERE ${subjectClause(subject)} AND thread_id = ${threadId}
  `))
  return row ? recordFromRow(row) : undefined
}

/** The thread that is an upstream comment, by its identity there. */
export async function readExternalThread(db: Db, subject: ThreadSubject, external: ExternalThreadIdentity): Promise<ThreadRecord | undefined> {
  const row = threadRowSchema.nullish().parse(await db.get(sql`
    SELECT ${THREAD_COLUMNS} FROM ${commentThreads}
    WHERE ${subjectClause(subject)} AND external_scope = ${external.scope} AND external_id = ${external.id}
  `))
  return row ? recordFromRow(row) : undefined
}

/**
 * The next position on the subject, by advancing its parent row's counter in
 * this transaction: the parent's row lock serializes two inserts on Postgres,
 * and the write transaction does on SQLite. A subject with no parent row cannot
 * be commented on.
 */
async function allocatePosition(db: Db, subject: ThreadSubject): Promise<number> {
  const counter = sql`comment_position = comment_position + 1`
  const statement = subject.kind === 'task'
    ? sql`UPDATE ${tasks} SET ${counter} WHERE id = ${subject.id} AND organization_id = ${subject.organizationId} RETURNING comment_position`
    : subject.kind === 'work'
      ? sql`UPDATE ${works} SET ${counter} WHERE id = ${subject.id} AND organization_id = ${subject.organizationId} RETURNING comment_position`
      : sql`UPDATE ${planAnnotations} SET ${counter} WHERE session_id = ${subject.id} AND plan_tool_use_id = ${subject.part ?? ''} AND organization_id = ${subject.organizationId} RETURNING comment_position`
  const row = z.object({ comment_position: z.number() }).nullish().parse((await db.all(statement))[0])
  if (!row) throw new Error(`No ${subject.kind} ${subject.id} to comment on.`)
  return row.comment_position
}

/**
 * Insert one thread. A thread already there under the id is left as it is and
 * the position counter is not advanced, so a redelivered write is a no-op;
 * the `ON CONFLICT` guards the race the pre-check cannot see, on the identity
 * and on the external index both. Returns whether the row was written.
 */
export async function insertThread(db: Db, subject: ThreadSubject, input: NewThread): Promise<boolean> {
  if (await db.get(sql`SELECT 1 AS present FROM ${commentThreads} WHERE ${subjectClause(subject)} AND thread_id = ${input.threadId}`)) return false
  const position = await allocatePosition(db, subject)
  const now = input.createdAt ?? Date.now()
  const result = await db.run(sql`
    INSERT INTO ${commentThreads} (
      organization_id, subject_kind, subject_id, subject_part, thread_id, body, created_by, author, source,
      origin_session_id, created_at, updated_at, position, version, delivery_state, external_scope, external_id, review
    ) VALUES (
      ${subject.organizationId}, ${subject.kind}, ${subject.id}, ${subject.part ?? ''}, ${input.threadId}, ${input.body},
      ${input.createdBy}, ${JSON.stringify(input.author)}, ${input.source ?? 'local'}, ${input.originSessionId ?? null},
      ${now}, ${now}, ${position}, 1, ${input.deliveryState ?? 'private'},
      ${input.external?.scope ?? null}, ${input.external?.id ?? null}, ${JSON.stringify(input.review ?? {})}
    )
    ON CONFLICT DO NOTHING
  `)
  return result.changes > 0
}

export interface ThreadPatch {
  body?: string
  author?: ThreadAuthor
  review?: ThreadReview
  deliveryState?: ThreadDeliveryState
  external?: ExternalThreadIdentity
  updatedAt?: number
}

/**
 * Change one thread, if it is still at `expectedVersion`. The version advances
 * with the row, so the next writer must have read this write. Returns whether
 * the row changed; false means the caller's copy is stale.
 */
export async function updateThread(db: Db, subject: ThreadSubject, threadId: string, expectedVersion: number, patch: ThreadPatch): Promise<boolean> {
  const assignments: SQL[] = [sql`version = version + 1`, sql`updated_at = ${patch.updatedAt ?? Date.now()}`]
  if (patch.body !== undefined) assignments.push(sql`body = ${patch.body}`)
  if (patch.author !== undefined) assignments.push(sql`author = ${JSON.stringify(patch.author)}`)
  if (patch.review !== undefined) assignments.push(sql`review = ${JSON.stringify(patch.review)}`)
  if (patch.deliveryState !== undefined) assignments.push(sql`delivery_state = ${patch.deliveryState}`)
  if (patch.external !== undefined) assignments.push(sql`external_scope = ${patch.external.scope}`, sql`external_id = ${patch.external.id}`)
  const result = await db.run(sql`
    UPDATE ${commentThreads} SET ${sql.join(assignments, sql`, `)}
    WHERE ${subjectClause(subject)} AND thread_id = ${threadId} AND version = ${expectedVersion}
  `)
  return result.changes > 0
}

/** Delete one thread; `guard` narrows it further (a version, a delivery state). */
export async function deleteThread(db: Db, subject: ThreadSubject, threadId: string, guard: SQL = sql`1 = 1`): Promise<boolean> {
  const result = await db.run(sql`
    DELETE FROM ${commentThreads} WHERE ${subjectClause(subject)} AND thread_id = ${threadId} AND ${guard}
  `)
  return result.changes > 0
}

/**
 * Every thread of a subject: the subject's delete or move calls this in its
 * own transaction, since a polymorphic subject has no foreign key to cascade.
 */
export async function deleteThreadsOf(db: Db, subject: ThreadSubject): Promise<number> {
  return (await db.run(sql`DELETE FROM ${commentThreads} WHERE ${subjectClause(subject)}`)).changes
}

// ─── Work and plan threads as `PlanComment`s ───

/** The review payload of a comment: what is not a column. */
export function reviewOf(comment: PlanComment): ThreadReview {
  const review: ThreadReview = { selectedText: comment.selectedText }
  if (comment.textOffset !== undefined) review.textOffset = comment.textOffset
  if (comment.pin !== undefined) review.pin = comment.pin
  if (comment.externalThreadId !== undefined) review.externalThreadId = comment.externalThreadId
  if (comment.googleThreadId !== undefined) review.googleThreadId = comment.googleThreadId
  if (comment.resolvedAt !== undefined) review.resolvedAt = comment.resolvedAt
  if (comment.resolvedBy !== undefined) review.resolvedBy = comment.resolvedBy
  if (comment.replies !== undefined) review.replies = comment.replies
  if (comment.readAt !== undefined) review.readAt = comment.readAt
  if (comment.readBy !== undefined) review.readBy = comment.readBy
  return review
}

/** A thread as the wire carries it. The keys come in one order, so two hosts hash it the same. */
export function commentOfThread(thread: ThreadRecord): PlanComment {
  const { review } = thread
  const comment: PlanComment = { id: thread.threadId, selectedText: review.selectedText ?? '', comment: thread.body }
  if (review.textOffset !== undefined) comment.textOffset = review.textOffset
  if (review.pin !== undefined) comment.pin = review.pin
  if (review.externalThreadId !== undefined) comment.externalThreadId = review.externalThreadId
  if (review.googleThreadId !== undefined) comment.googleThreadId = review.googleThreadId
  if (thread.author.kind !== 'external') comment.author = thread.author
  comment.createdAt = thread.createdAt
  if (review.resolvedAt !== undefined) comment.resolvedAt = review.resolvedAt
  if (review.resolvedBy !== undefined) comment.resolvedBy = review.resolvedBy
  if (review.replies !== undefined) comment.replies = review.replies
  if (review.readAt !== undefined) comment.readAt = review.readAt
  if (review.readBy !== undefined) comment.readBy = review.readBy
  return comment
}

/** A subject's threads as `PlanComment`s, in reading order. */
export async function readComments(db: Db, subject: ThreadSubject): Promise<PlanComment[]> {
  return (await readThreads(db, subject)).map(commentOfThread)
}

/** The newest change among a subject's threads; 0 when it has none. */
export async function threadsUpdatedAt(db: Db, subject: ThreadSubject): Promise<number> {
  const row = z.object({ updated_at: z.number().nullable() }).parse(await db.get(sql`
    SELECT MAX(updated_at) AS updated_at FROM ${commentThreads} WHERE ${subjectClause(subject)}
  `))
  return row.updated_at ?? 0
}

/**
 * The time of the subject's newest thread; 0 when it has none. A task comment is
 * stamped after it, even within one millisecond, so the `(created_at, thread_id)`
 * order is the order the comments were written in.
 */
export async function newestThreadCreatedAt(db: Db, subject: ThreadSubject): Promise<number> {
  const row = z.object({ created_at: z.number().nullable() }).parse(await db.get(sql`
    SELECT MAX(created_at) AS created_at FROM ${commentThreads} WHERE ${subjectClause(subject)}
  `))
  return row.created_at ?? 0
}

/** The threads a command changed: the text before and after, for the mentions a change first saves. */
export interface ThreadChange {
  before: PlanComment[]
  after: PlanComment[]
}

/** How many times a command is reapplied to a thread another writer changed under it. */
const COMMAND_ATTEMPTS = 5

/**
 * Apply one command to a subject's threads (docs/plans/multiplayer-comments.md):
 * the reducer decides what it does and who may do it; this reads the one thread
 * it names, applies it, and writes the row back if nobody wrote it in between.
 * A thread that moved is read again and the command reapplied to it, so a
 * reply lands beside the one that beat it instead of over it. A new thread is
 * one insert; `resolve-open` is one update per open thread.
 */
export async function applyThreadCommand(db: Db, subject: ThreadSubject, command: WorkCommentCommand, actor: CommentActor): Promise<ThreadChange> {
  if (command.kind === 'add') {
    const created = applyCommentCommand([], command, actor)[0]!
    const inserted = await insertThread(db, subject, {
      threadId: created.id,
      body: created.comment,
      author: actor.by,
      createdBy: creatorKeyOf(actor.by),
      createdAt: actor.now,
      review: reviewOf(created),
    })
    if (!inserted) throw new CommentCommandError('CONFLICT', `Thread ${created.id} already exists.`)
    return { before: [], after: [created] }
  }
  if (command.kind === 'resolve-open') {
    for (const thread of await readThreads(db, subject)) {
      if (thread.review.resolvedAt !== undefined) continue
      await applyToThread(db, subject, { kind: 'resolve', commentId: thread.threadId, resolved: true }, actor)
    }
    return { before: [], after: [] }
  }
  return applyToThread(db, subject, command, actor)
}

async function applyToThread(
  db: Db,
  subject: ThreadSubject,
  command: Exclude<WorkCommentCommand, { kind: 'add' | 'resolve-open' }>,
  actor: CommentActor,
): Promise<ThreadChange> {
  for (let attempt = 0; attempt < COMMAND_ATTEMPTS; attempt++) {
    const thread = await readThread(db, subject, command.commentId)
    if (!thread) throw new CommentCommandError('NOT_FOUND', `No thread ${command.commentId}.`)
    const current = commentOfThread(thread)
    const [next] = applyCommentCommand([current], command, actor)
    if (!next) {
      if (await deleteThread(db, subject, thread.threadId, sql`version = ${thread.version}`)) return { before: [current], after: [] }
      continue
    }
    if (await updateThread(db, subject, thread.threadId, thread.version, { body: next.comment, review: reviewOf(next), updatedAt: actor.now })) {
      return { before: [current], after: [next] }
    }
  }
  throw new CommentCommandError('CONFLICT', `Thread ${command.commentId} kept changing under the command.`)
}

export interface ThreadBatch {
  /** The `updatedAt` the caller's copy of the threads was read at (the host's clock). */
  snapshotAt: number
  /** Who sends the batch: the author of what it has not stamped, and whose own threads it may delete. */
  by: Attribution
  now: number
}

function sameComment(a: PlanComment, b: PlanComment): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** `stored` with the replies of `incoming` it does not have: the one change a stale copy may still make. */
function withNewReplies(stored: PlanComment, incoming: PlanComment): PlanComment {
  const known = new Set((stored.replies ?? []).map((reply) => reply.id))
  const added = (incoming.replies ?? []).filter((reply) => !known.has(reply.id))
  return added.length ? { ...stored, replies: [...(stored.replies ?? []), ...added] } : stored
}

/**
 * A client's whole copy of a subject's threads, reconciled thread by thread
 * (plans/029 §5.2: a whole-array save is a version-checked batch). A thread
 * the copy adds is inserted; one it changed is written if the stored thread is
 * no newer than the copy, else only its new replies are added, since the
 * stored thread holds a change the copy never saw; one it left out is deleted
 * only when the copy saw its latest change, or when the sender wrote it.
 */
export async function reconcileThreads(db: Db, subject: ThreadSubject, comments: readonly PlanComment[], batch: ThreadBatch): Promise<void> {
  const stored = new Map((await readThreads(db, subject)).map((thread) => [thread.threadId, thread]))
  const sent = new Set<string>()
  for (const incoming of comments) {
    sent.add(incoming.id)
    const thread = stored.get(incoming.id)
    if (!thread) {
      const author = incoming.author ?? batch.by
      await insertThread(db, subject, {
        threadId: incoming.id,
        body: incoming.comment,
        author,
        createdBy: creatorKeyOf(author),
        createdAt: incoming.createdAt ?? batch.now,
        review: reviewOf({ ...incoming, author }),
      })
      continue
    }
    const current = commentOfThread(thread)
    const next = thread.updatedAt <= batch.snapshotAt ? { ...incoming, createdAt: current.createdAt } : withNewReplies(current, incoming)
    if (sameComment(current, next)) continue
    await updateThread(db, subject, thread.threadId, thread.version, { body: next.comment, review: reviewOf(next), updatedAt: batch.now })
  }
  for (const thread of stored.values()) {
    if (sent.has(thread.threadId)) continue
    const own = thread.author.kind === 'user' && batch.by.kind === 'user' && sameUser(thread.author.user.id, batch.by.user.id)
    if (thread.updatedAt <= batch.snapshotAt || own) await deleteThread(db, subject, thread.threadId, sql`version = ${thread.version}`)
  }
}
