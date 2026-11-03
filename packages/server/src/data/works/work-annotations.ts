import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../../db/database'
import type { WorkExternalComments } from '@solus/contracts/work-comments'
import type { WorkAnnotations } from '@solus/contracts/types'
import type { CommentActor, WorkCommentCommand } from '@solus/contracts/comment-commands'
import { notifyAnnotationsChanged } from '../../annotations/annotation-events'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { works } from './schema'
import { recordThreadMentions } from '../activity/mentions'
import {
  applyThreadCommand,
  creatorKeyOf,
  insertThread,
  readComments,
  reviewOf,
  threadsUpdatedAt,
  type ThreadSubject,
} from '../comments/comment-threads'

/**
 * A work's comments (docs/plans/multiplayer-comments.md): its threads are
 * `comment_threads` rows under the work, and the linked document's threads and
 * the operations sent to it are `works.external_comments`, guarded by their own
 * version (plans/029 §5.2). The wire still carries both as one
 * `WorkAnnotations`; a private comment command never touches the external
 * state, and a refresh of the external state never touches a thread.
 */

const stateRowSchema = z.object({
  organization_id: z.string(),
  external_comments: z.string().nullable(),
  external_comments_version: z.number(),
})

/** The external comment state of a work, with the version a write must name. */
export interface ExternalCommentState {
  state: WorkExternalComments | undefined
  version: number
}

interface WorkCommentState extends ExternalCommentState {
  organizationId: string
}

function threadsOf(organizationId: string, workId: string): ThreadSubject {
  return { organizationId, kind: 'work', id: workId }
}

/**
 * The work's organization and external comment state: the work's own
 * organization (organization-scope §3, owned children inherit). A work outside
 * the scope, or one that does not exist, has none. A write needs the work here:
 * a moved work's comments are read, never changed.
 */
async function commentState(db: Db, scope: RecordScope, workId: string, forWrite = false): Promise<WorkCommentState | null> {
  const here = forWrite ? sql` AND location IS NULL` : sql``
  const row = stateRowSchema.nullish().parse(await db.get(sql`
    SELECT organization_id, external_comments, external_comments_version FROM ${works}
    WHERE id = ${workId} AND ${scopeClause(scope)}${here}
  `))
  if (!row) return null
  return {
    organizationId: row.organization_id,
    // SAFETY: `saveExternalComments` is the sole writer and serializes the `WorkExternalComments` contract.
    state: row.external_comments ? JSON.parse(row.external_comments) as WorkExternalComments : undefined,
    version: row.external_comments_version,
  }
}

async function annotationsOf(db: Db, workId: string, state: WorkCommentState): Promise<WorkAnnotations> {
  const subject = threadsOf(state.organizationId, workId)
  const annotations: WorkAnnotations = {
    version: 1,
    workId,
    comments: await readComments(db, subject),
    updatedAt: await threadsUpdatedAt(db, subject),
  }
  if (state.state) annotations.externalComments = state.state
  return annotations
}

/** The work's threads and external comment state; null for a work not in scope. */
export async function loadWorkAnnotations(scope: RecordScope, workId: string): Promise<WorkAnnotations | null> {
  const db = getDatabase()
  const state = await commentState(db, scope, workId)
  return state ? annotationsOf(db, workId, state) : null
}

export async function readExternalComments(scope: RecordScope, workId: string): Promise<ExternalCommentState> {
  const state = await commentState(getDatabase(), scope, workId)
  if (!state) throw new Error(`Work not found: ${workId}`)
  return { state: state.state, version: state.version }
}

/**
 * Write the external comment state, if it is still at `expectedVersion`: a
 * refresh that read an older state is refused instead of overwriting a newer
 * one. Returns the version the write made. Private threads are not read or
 * written here, so a shared refresh cannot replace a private edit.
 */
export async function saveExternalComments(scope: RecordScope, workId: string, externalComments: WorkExternalComments, expectedVersion?: number): Promise<number> {
  return getDatabase().transaction(async (db) => {
    const current = await commentState(db, scope, workId, true)
    if (!current) throw new Error(`Work not found: ${workId}`)
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new Error('The external comments changed. Refresh this work.')
    await db.run(sql`
      UPDATE ${works} SET external_comments = ${JSON.stringify(externalComments)}, external_comments_version = ${current.version + 1}
      WHERE id = ${workId} AND organization_id = ${current.organizationId}
    `)
    return current.version + 1
  })
}

/**
 * One person's change to a work's threads (docs/plans/multiplayer-comments.md).
 * The command is applied to the one thread it names, against the version it was
 * read at: two people commenting at once each land beside the other's result
 * instead of over it. Everyone who can open the work is told, so their rails
 * re-read. A person a message first mentions is recorded as `mentioned` activity.
 */
export async function applyWorkComment(
  scope: RecordScope,
  workId: string,
  command: WorkCommentCommand,
  actor: CommentActor,
): Promise<WorkAnnotations> {
  const next = await getDatabase().transaction(async (db) => {
    const state = await commentState(db, scope, workId, true)
    if (!state) throw new Error(`Work not found: ${workId}`)
    const change = await applyThreadCommand(db, threadsOf(state.organizationId, workId), command, actor)
    await recordThreadMentions(db, state.organizationId, { kind: 'work', id: workId }, actor.by, change.before, change.after)
    return annotationsOf(db, workId, state)
  })
  notifyAnnotationsChanged({ kind: 'work', targetId: workId })
  return next
}

/**
 * A transferred work's comments, written under the work that was just made in
 * `organizationId` (`importWorkFromHost`): every thread as it was, in its order,
 * and the external state as it was. The threads are new rows under a new work,
 * so there is no copy here they could be stale against.
 */
export async function importWorkAnnotations(db: Db, organizationId: string, workId: string, annotations: WorkAnnotations): Promise<void> {
  const subject = threadsOf(organizationId, workId)
  for (const comment of annotations.comments) {
    const author = comment.author ?? { kind: 'system' as const }
    await insertThread(db, subject, {
      threadId: comment.id,
      body: comment.comment,
      author,
      createdBy: creatorKeyOf(author),
      createdAt: comment.createdAt,
      review: reviewOf(comment),
    })
  }
  if (annotations.externalComments) {
    await db.run(sql`
      UPDATE ${works} SET external_comments = ${JSON.stringify(annotations.externalComments)}, external_comments_version = 1
      WHERE id = ${workId} AND organization_id = ${organizationId}
    `)
  }
}
