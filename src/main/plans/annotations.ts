import type { DatabaseSync } from 'node:sqlite'
import type { PlanAnnotations } from '../../shared/types'
import { getDb, withTx } from '../db'

interface AnnotationRow {
  session_id: string
  plan_tool_use_id: string
  status: PlanAnnotations['status']
  title: string
  bookmarked: number
  bookmarked_at: number | null
  project_path: string
  cwd: string
  comments: string
  updated_at: number
}

function toRowValues(ann: PlanAnnotations): [string, string, string, string, number, number | null, string, string, string, number] {
  return [
    ann.sessionId,
    ann.planToolUseId,
    ann.status,
    ann.title,
    ann.bookmarked ? 1 : 0,
    ann.bookmarkedAt ?? null,
    ann.projectPath,
    ann.cwd,
    JSON.stringify(ann.comments),
    ann.updatedAt,
  ]
}

function fromRow(row: AnnotationRow): PlanAnnotations {
  return {
    version: 1,
    sessionId: row.session_id,
    projectPath: row.project_path,
    cwd: row.cwd,
    planToolUseId: row.plan_tool_use_id,
    title: row.title,
    status: row.status,
    comments: JSON.parse(row.comments) as PlanAnnotations['comments'],
    bookmarked: row.bookmarked === 1,
    ...(row.bookmarked_at === null ? {} : { bookmarkedAt: row.bookmarked_at }),
    updatedAt: row.updated_at,
  }
}

function annotationRow(db: DatabaseSync, sessionId: string, planToolUseId: string): AnnotationRow | undefined {
  return db.prepare(`
    SELECT session_id, plan_tool_use_id, status, title, bookmarked,
           bookmarked_at, project_path, cwd, comments, updated_at
    FROM plan_annotations
    WHERE session_id = ? AND plan_tool_use_id = ?
  `).get(sessionId, planToolUseId) as AnnotationRow | undefined
}

function writeAnnotations(db: DatabaseSync, ann: PlanAnnotations): void {
  db.prepare(`
    INSERT INTO plan_annotations (
      session_id, plan_tool_use_id, status, title, bookmarked,
      bookmarked_at, project_path, cwd, comments, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, plan_tool_use_id) DO UPDATE SET
      status = excluded.status,
      title = excluded.title,
      bookmarked = excluded.bookmarked,
      bookmarked_at = excluded.bookmarked_at,
      project_path = excluded.project_path,
      cwd = excluded.cwd,
      comments = excluded.comments,
      updated_at = excluded.updated_at
  `).run(...toRowValues(ann))
}

export async function loadAnnotations(sessionId: string, planToolUseId: string): Promise<PlanAnnotations | null> {
  try {
    const row = annotationRow(getDb(), sessionId, planToolUseId)
    return row ? fromRow(row) : null
  } catch {
    return null
  }
}

export async function saveAnnotations(ann: PlanAnnotations): Promise<void> {
  const merged: PlanAnnotations = { ...ann, updatedAt: Date.now() }
  writeAnnotations(getDb(), merged)
}

export async function toggleBookmarkAnnotations(
  sessionId: string,
  projectPath: string,
  cwd: string,
  planToolUseId: string,
  title: string,
): Promise<PlanAnnotations> {
  return withTx(() => {
    const db = getDb()
    const row = annotationRow(db, sessionId, planToolUseId)
    const existing = row ? fromRow(row) : null
    const bookmarked = !existing?.bookmarked
    const merged: PlanAnnotations = {
      version: 1,
      sessionId,
      projectPath,
      cwd,
      planToolUseId,
      title: existing?.title || title,
      status: existing?.status ?? 'pending',
      comments: existing?.comments ?? [],
      bookmarked,
      ...(bookmarked ? { bookmarkedAt: Date.now() } : {}),
      updatedAt: Date.now(),
    }
    writeAnnotations(db, merged)
    return merged
  })
}

export interface AnnotationIndex {
  [key: string]: PlanAnnotations  // key = sessionId + '__' + planToolUseId
}

/** Load every annotation into a map keyed by `${sessionId}__${planToolUseId}`. Used once by the indexer. */
export async function loadAllAnnotations(): Promise<AnnotationIndex> {
  const rows = getDb().prepare(`
    SELECT session_id, plan_tool_use_id, status, title, bookmarked,
           bookmarked_at, project_path, cwd, comments, updated_at
    FROM plan_annotations
  `).all() as unknown as AnnotationRow[]
  const out: AnnotationIndex = {}
  for (const row of rows) {
    try {
      const annotation = fromRow(row)
      out[`${annotation.sessionId}__${annotation.planToolUseId}`] = annotation
    } catch {}
  }
  return out
}
