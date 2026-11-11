import { sql } from 'drizzle-orm'
import { ulid } from '@solus/contracts/ulid'
import type { TaskComment } from '@solus/contracts/task-types'
import type { Attribution } from '@solus/contracts/user'
import type { Db } from '../../db/database'
import { LOCAL_ORGANIZATION_ID } from '../../host/host-category'
import { hostUserKey } from '../../host/host-user'
import {
  creatorKeyOf,
  deleteThread,
  insertThread,
  newestThreadCreatedAt,
  readExternalThread,
  readThread,
  readThreads,
  updateThread,
  type ThreadRecord,
  type ThreadSubject,
} from '../comments/comment-threads'
import { database, normalizedOptional } from './task-store'
import type { ProviderComment } from './providers/types'

/**
 * A task's comments on this host (docs/plans/provider-owned-tasks.md §4.4).
 * Each comment is a provider comment. The host keeps a copy of the comments it
 * read with a task (`sent`), so they can be searched and shown offline, and
 * the comments that the provider did not take yet (`pending`), with the reason.
 * A task has no organization, so its threads are in `local`.
 */

/** The comment threads of a task: the subject every thread write names. */
export function taskThreads(taskId: string): ThreadSubject {
  return { organizationId: LOCAL_ORGANIZATION_ID, kind: 'task', id: taskId }
}

/** A task's comment, from its thread row. A comment that Solus sent keeps who
 *  wrote it; a comment only read from the provider has the provider's name. */
function taskCommentOf(taskId: string, thread: ThreadRecord): TaskComment {
  const comment: TaskComment = { id: thread.threadId, taskId, body: thread.body, createdAt: thread.createdAt }
  if (thread.author.kind === 'external') comment.externalAuthor = thread.author.name
  else comment.author = thread.author
  if (thread.originSessionId !== null) comment.originSessionId = thread.originSessionId
  if (thread.deliveryState === 'pending') {
    comment.unsent = true
    if (thread.review.sendError) comment.sendError = thread.review.sendError
  }
  return comment
}

/** The task's comments, oldest first; two written in one millisecond keep their id order. */
export async function commentsForTask(taskId: string, db: Db = database()): Promise<TaskComment[]> {
  return (await readThreads(db, taskThreads(taskId))).map((thread) => taskCommentOf(taskId, thread))
}

/**
 * Make the host's copy of a task's sent comments equal to what the provider
 * answered. A comment that Solus sent keeps its row and its author. A comment
 * that is not on the provider any more goes, unless the provider gave only a
 * part of the comments. Unsent comments are never touched. Inside the caller's
 * transaction; needs the task's row.
 */
export async function storeProviderComments(
  db: Db,
  taskId: string,
  comments: readonly ProviderComment[],
  commentsTruncated: boolean,
): Promise<void> {
  const subject = taskThreads(taskId)
  const onProvider = new Set(comments.map((comment) => comment.id))
  for (const comment of comments) {
    const held = await readExternalThread(db, subject, { scope: taskId, id: comment.id })
    if (!held) {
      await insertThread(db, subject, {
        threadId: ulid(comment.createdAt),
        body: comment.body,
        author: { kind: 'external', name: comment.author },
        createdBy: hostUserKey(),
        source: 'external',
        createdAt: comment.createdAt,
        deliveryState: 'sent',
        external: { scope: taskId, id: comment.id },
      })
    } else if (held.body !== comment.body) {
      await updateThread(db, subject, held.threadId, held.version, { body: comment.body })
    }
  }
  if (commentsTruncated) return
  for (const thread of await readThreads(db, subject)) {
    if (thread.deliveryState !== 'sent' || !thread.external || onProvider.has(thread.external.id)) continue
    await deleteThread(db, subject, thread.threadId, sql`delivery_state = 'sent'`)
  }
}

export interface NewTaskComment {
  body: string
  /** Who wrote it: the admitted actor, or the agent that asked. */
  by: Attribution
  originSessionId?: string | null
  /** A caller's own id for the comment, so that a write sent two times makes one row. */
  id?: string
}

/** Whether the host holds a comment under this id: a write sent two times must not post two times. */
export async function hasComment(taskId: string, commentId: string): Promise<boolean> {
  return !!(await readThread(database(), taskThreads(taskId), commentId))
}

/** Keep a comment that the provider took. Answers the comment's id on this host. */
export async function storeSentComment(taskId: string, input: NewTaskComment, sent: ProviderComment): Promise<string> {
  return database().transaction(async (db) => {
    const subject = taskThreads(taskId)
    const now = Math.max(sent.createdAt, await newestThreadCreatedAt(db, subject) + 1)
    const threadId = input.id ?? ulid(now)
    await insertThread(db, subject, {
      threadId,
      body: sent.body,
      author: input.by,
      createdBy: creatorKeyOf(input.by),
      originSessionId: normalizedOptional(input.originSessionId),
      createdAt: now,
      deliveryState: 'sent',
      external: { scope: taskId, id: sent.id },
    })
    return threadId
  })
}

/** Keep a comment that the provider did not take, with the reason. It stays
 *  on this host until it is sent again or discarded. */
export async function storeUnsentComment(taskId: string, input: NewTaskComment, sendError: string): Promise<string> {
  return database().transaction(async (db) => {
    const subject = taskThreads(taskId)
    // Written after the comment before it, even within one millisecond: the
    // comments read in `(created_at, id)` order, and ids are not ordered within a millisecond.
    const now = Math.max(Date.now(), await newestThreadCreatedAt(db, subject) + 1)
    const threadId = input.id ?? ulid(now)
    await insertThread(db, subject, {
      threadId,
      body: input.body,
      author: input.by,
      createdBy: creatorKeyOf(input.by),
      originSessionId: normalizedOptional(input.originSessionId),
      createdAt: now,
      deliveryState: 'pending',
      review: { sendError },
    })
    return threadId
  })
}

/** An unsent comment of a task, or an error that says why there is none to send or discard. */
export async function requireUnsentComment(taskId: string, commentId: string): Promise<ThreadRecord> {
  const thread = await readThread(database(), taskThreads(taskId), commentId)
  if (!thread) throw new Error('This task comment no longer exists.')
  if (thread.deliveryState !== 'pending') throw new Error('This comment is on the provider already. Change or delete it there.')
  return thread
}

/** The provider took an unsent comment. */
export async function markCommentSent(taskId: string, thread: ThreadRecord, sent: ProviderComment): Promise<void> {
  await updateThread(database(), taskThreads(taskId), thread.threadId, thread.version, {
    deliveryState: 'sent',
    external: { scope: taskId, id: sent.id },
    review: {},
  })
}

/** A send of an unsent comment failed again: keep the new reason. */
export async function markCommentFailed(taskId: string, thread: ThreadRecord, sendError: string): Promise<void> {
  await updateThread(database(), taskThreads(taskId), thread.threadId, thread.version, { review: { sendError } })
}

/** Discard an unsent comment. A comment sent while this ran stays. */
export async function discardUnsentComment(taskId: string, commentId: string): Promise<boolean> {
  return deleteThread(database(), taskThreads(taskId), commentId, sql`delivery_state = 'pending'`)
}
