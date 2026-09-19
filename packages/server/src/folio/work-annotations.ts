import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../db/database'
import type { WorkExternalComments } from '@solus/contracts/work-comments'
import type { WorkAnnotations } from '@solus/contracts/types'
import { applyCommentCommand, type CommentActor, type WorkCommentCommand } from '@solus/contracts/comment-commands'
import { notifyAnnotationsChanged } from '../annotations/annotation-events'
import { workAnnotations } from './schema'

const annotationRowSchema = z.object({ data: z.string().nullable() })

async function readAnnotations(db: Db, organizationId: string, workId: string): Promise<WorkAnnotations | null> {
  try {
    const row = annotationRowSchema.nullish().parse(await db.get(sql`
      SELECT data FROM ${workAnnotations} WHERE work_id = ${workId} AND organization_id = ${organizationId}
    `))
    // SAFETY: writeAnnotations is the sole writer and serializes the WorkAnnotations contract.
    return row?.data ? JSON.parse(row.data) as WorkAnnotations : null
  } catch {
    return null
  }
}

export async function loadWorkAnnotations(organizationId: string, workId: string): Promise<WorkAnnotations | null> {
  return readAnnotations(getDatabase(), organizationId, workId)
}

/** One read and one write in a transaction: shared refreshes preserve current private edits. */
export async function saveExternalComments(organizationId: string, workId: string, externalComments: WorkExternalComments): Promise<void> {
  await getDatabase().transaction(async (db) => {
    const current = await readAnnotations(db, organizationId, workId) ?? { version: 1, workId, comments: [], updatedAt: 0 }
    await writeAnnotations(db, organizationId, {
      ...current,
      externalComments,
      googleComments: externalComments.provider === 'gdrive' ? externalComments : undefined,
    })
  })
}

export async function saveWorkAnnotations(organizationId: string, ann: WorkAnnotations): Promise<void> {
  await getDatabase().transaction(async (db) => {
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
 * is told, so their rails re-read.
 */
export async function applyWorkComment(
  organizationId: string,
  workId: string,
  command: WorkCommentCommand,
  actor: CommentActor,
): Promise<WorkAnnotations> {
  const next = await getDatabase().transaction(async (db) => {
    const current = await readAnnotations(db, organizationId, workId) ?? { version: 1, workId, comments: [], updatedAt: 0 }
    const merged: WorkAnnotations = { ...current, comments: applyCommentCommand(current.comments, command, actor) }
    await writeAnnotations(db, organizationId, merged)
    return await readAnnotations(db, organizationId, workId) ?? merged
  })
  notifyAnnotationsChanged({ kind: 'work', targetId: workId })
  return next
}

async function writeAnnotations(db: Db, organizationId: string, ann: WorkAnnotations): Promise<void> {
  const merged: WorkAnnotations = { ...ann, version: 1, updatedAt: Date.now() }
  await db.run(sql`
    INSERT INTO ${workAnnotations} (work_id, data, updated_at, organization_id)
    VALUES (${merged.workId}, ${JSON.stringify(merged)}, ${merged.updatedAt}, ${organizationId})
    ON CONFLICT(work_id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at,
      organization_id = excluded.organization_id
  `)
}
