import { getDb } from '../db'
import type { WorkExternalComments } from '@solus/contracts/work-comments'
import type { WorkAnnotations } from '@solus/contracts/types'
import { applyCommentCommand, type CommentActor, type WorkCommentCommand } from '@solus/contracts/comment-commands'
import { notifyAnnotationsChanged } from '../annotations/annotation-events'

interface WorkAnnotationRow {
  data: string | null
}

export function loadWorkAnnotations(workId: string): WorkAnnotations | null {
  try {
    // SAFETY: this query selects only the nullable text column declared by WorkAnnotationRow.
    const row = getDb().prepare('SELECT data FROM work_annotations WHERE work_id = ?').get(workId) as WorkAnnotationRow | undefined
    // SAFETY: saveWorkAnnotations is the sole writer and serializes the WorkAnnotations contract.
    return row?.data ? JSON.parse(row.data) as WorkAnnotations : null
  } catch {
    return null
  }
}

/** No await between read and write: shared refreshes preserve current private edits. */
export function saveExternalComments(workId: string, externalComments: WorkExternalComments): void {
  const current = loadWorkAnnotations(workId) ?? { version: 1, workId, comments: [], updatedAt: 0 }
  writeAnnotations({ ...current, externalComments, googleComments: externalComments.provider === 'gdrive' ? externalComments : undefined })
}

export async function saveWorkAnnotations(ann: WorkAnnotations): Promise<void> {
  const current = loadWorkAnnotations(ann.workId)
  writeAnnotations({ version: 1, workId: ann.workId, comments: ann.comments, updatedAt: ann.updatedAt, externalComments: current?.externalComments, googleComments: current?.googleComments })
}

/**
 * One person's change to a work's threads (docs/plans/multiplayer-comments.md).
 * Read, apply, write, with no await between: two people commenting at once each
 * land on the other's result instead of over it. Everyone who can open the work
 * is told, so their rails re-read.
 */
export function applyWorkComment(workId: string, command: WorkCommentCommand, actor: CommentActor): WorkAnnotations {
  const current = loadWorkAnnotations(workId) ?? { version: 1, workId, comments: [], updatedAt: 0 }
  const next: WorkAnnotations = { ...current, comments: applyCommentCommand(current.comments, command, actor) }
  writeAnnotations(next)
  notifyAnnotationsChanged({ kind: 'work', targetId: workId })
  return loadWorkAnnotations(workId) ?? next
}

function writeAnnotations(ann: WorkAnnotations): void {
  const merged: WorkAnnotations = { ...ann, version: 1, updatedAt: Date.now() }
  getDb().prepare(`
    INSERT INTO work_annotations (work_id, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(work_id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run(merged.workId, JSON.stringify(merged), merged.updatedAt)
}
