import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../../db/database'
import type { WorkExternalComments } from '@solus/contracts/work-comments'
import type { WorkAnnotations } from '@solus/contracts/types'
import { applyCommentCommand, type CommentActor, type WorkCommentCommand } from '@solus/contracts/comment-commands'
import { notifyAnnotationsChanged } from '../../annotations/annotation-events'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { workAnnotations, works } from './schema'
import { readStoredComments, type StoredThread } from '../../annotations/stored-comments'
import { hostUser } from '../../host/host-user'
import { recordThreadMentions } from '../activity/mentions'

const annotationRowSchema = z.object({ data: z.string().nullable() })

async function readAnnotations(db: Db, scope: RecordScope, workId: string): Promise<WorkAnnotations | null> {
  try {
    const row = annotationRowSchema.nullish().parse(await db.get(sql`
      SELECT data FROM ${workAnnotations} WHERE work_id = ${workId} AND ${scopeClause(scope)}
    `))
    if (!row?.data) return null
    // SAFETY: writeAnnotations is the sole writer and serializes the WorkAnnotations contract; an older row holds older threads.
    const stored = JSON.parse(row.data) as Omit<WorkAnnotations, 'comments'> & { comments: StoredThread[] }
    return { ...stored, comments: readStoredComments(stored.comments, hostUser()) }
  } catch {
    return null
  }
}

export async function loadWorkAnnotations(scope: RecordScope, workId: string): Promise<WorkAnnotations | null> {
  return readAnnotations(getDatabase(), scope, workId)
}

/**
 * The organization a work's annotations belong to: the work's own
 * (organization-scope §3, owned children inherit). A work outside the scope, or
 * one that does not exist, has no annotations to write.
 */
async function organizationOfWork(db: Db, scope: RecordScope, workId: string): Promise<string> {
  const row = z.object({ organization_id: z.string() }).nullish().parse(await db.get(sql`
    SELECT organization_id FROM ${works} WHERE id = ${workId} AND ${scopeClause(scope)} AND location IS NULL
  `))
  if (!row) throw new Error(`Work not found: ${workId}`)
  return row.organization_id
}

/** One read and one write in a transaction: shared refreshes preserve current private edits. */
export async function saveExternalComments(scope: RecordScope, workId: string, externalComments: WorkExternalComments): Promise<void> {
  await getDatabase().transaction(async (db) => {
    const organizationId = await organizationOfWork(db, scope, workId)
    const current = await readAnnotations(db, organizationId, workId) ?? { version: 1, workId, comments: [], updatedAt: 0 }
    await writeAnnotations(db, organizationId, {
      ...current,
      externalComments,
      googleComments: externalComments.provider === 'gdrive' ? externalComments : undefined,
    })
  })
}

export async function saveWorkAnnotations(scope: RecordScope, ann: WorkAnnotations): Promise<void> {
  await getDatabase().transaction(async (db) => {
    const organizationId = await organizationOfWork(db, scope, ann.workId)
    const current = await readAnnotations(db, organizationId, ann.workId)
    await writeAnnotations(db, organizationId, {
      version: 1,
      workId: ann.workId,
      comments: ann.comments,
      updatedAt: ann.updatedAt,
      externalComments: current?.externalComments,
      googleComments: current?.googleComments,
    })
  })
}

/**
 * One person's change to a work's threads (docs/plans/multiplayer-comments.md).
 * Read, apply, write in one transaction: two people commenting at once each
 * land on the other's result instead of over it. Everyone who can open the work
 * is told, so their rails re-read. A person a message first mentions is recorded
 * as `mentioned` activity.
 */
export async function applyWorkComment(
  scope: RecordScope,
  workId: string,
  command: WorkCommentCommand,
  actor: CommentActor,
): Promise<WorkAnnotations> {
  const next = await getDatabase().transaction(async (db) => {
    const organizationId = await organizationOfWork(db, scope, workId)
    const current = await readAnnotations(db, organizationId, workId) ?? { version: 1, workId, comments: [], updatedAt: 0 }
    const merged: WorkAnnotations = { ...current, comments: applyCommentCommand(current.comments, command, actor) }
    await writeAnnotations(db, organizationId, merged)
    await recordThreadMentions(db, organizationId, { kind: 'work', id: workId }, actor.by, current.comments, merged.comments)
    return await readAnnotations(db, organizationId, workId) ?? merged
  })
  notifyAnnotationsChanged({ kind: 'work', targetId: workId })
  return next
}

async function writeAnnotations(db: Db, organizationId: string, ann: WorkAnnotations): Promise<void> {
  const merged = { ...ann, version: 1, updatedAt: Date.now() }
  await db.run(sql`
    INSERT INTO ${workAnnotations} (work_id, data, updated_at, organization_id)
    VALUES (${merged.workId}, ${JSON.stringify(merged)}, ${merged.updatedAt}, ${organizationId})
    ON CONFLICT(work_id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at,
      organization_id = excluded.organization_id
  `)
}
