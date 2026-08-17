import type { DatabaseSync } from 'node:sqlite'
import type { PlanAnnotations } from '../../shared/types'
import { getDb, withTx } from '../db'
import { z } from 'zod'

const commentAgentAuthorSchema = z.object({
  sessionId: z.string(),
  title: z.string().optional(),
  provider: z.enum(['claude-code', 'codex', 'opencode']),
})

const commentReplySchema = z.object({
  id: z.string(),
  author: z.enum(['you', 'solus']),
  authorAgent: commentAgentAuthorSchema.optional(),
  text: z.string(),
  createdAt: z.number(),
})

const planCommentSchema = z.object({
  id: z.string(),
  selectedText: z.string(),
  comment: z.string(),
  textOffset: z.number().optional(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
  author: z.enum(['you', 'solus']).optional(),
  authorAgent: commentAgentAuthorSchema.optional(),
  createdAt: z.number().optional(),
  resolvedAt: z.number().optional(),
  resolvedBy: z.enum(['you', 'solus']).optional(),
  replies: z.array(commentReplySchema).optional(),
})

const annotationRowSchema = z.object({
  session_id: z.string(),
  plan_tool_use_id: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  title: z.string(),
  bookmarked: z.number(),
  bookmarked_at: z.number().nullable(),
  project_path: z.string(),
  cwd: z.string(),
  comments: z.string(),
  updated_at: z.number(),
})

type AnnotationRow = z.infer<typeof annotationRowSchema>

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
  const annotation: PlanAnnotations = {
    version: 1,
    sessionId: row.session_id,
    projectPath: row.project_path,
    cwd: row.cwd,
    planToolUseId: row.plan_tool_use_id,
    title: row.title,
    status: row.status,
    comments: z.array(planCommentSchema).parse(JSON.parse(row.comments)),
    bookmarked: row.bookmarked === 1,
    updatedAt: row.updated_at,
  }
  if (row.bookmarked_at !== null) annotation.bookmarkedAt = row.bookmarked_at
  return annotation
}

function annotationRow(db: DatabaseSync, sessionId: string, planToolUseId: string): AnnotationRow | undefined {
  const parsed = annotationRowSchema.safeParse(db.prepare(`
    SELECT session_id, plan_tool_use_id, status, title, bookmarked,
           bookmarked_at, project_path, cwd, comments, updated_at
    FROM plan_annotations
    WHERE session_id = ? AND plan_tool_use_id = ?
  `).get(sessionId, planToolUseId))
  return parsed.success ? parsed.data : undefined
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
      updatedAt: Date.now(),
    }
    if (bookmarked) merged.bookmarkedAt = Date.now()
    writeAnnotations(db, merged)
    return merged
  })
}

export type AnnotationIndex = Map<string, PlanAnnotations>

/** Load every annotation into a map keyed by `${sessionId}__${planToolUseId}`. Used once by the indexer. */
export async function loadAllAnnotations(): Promise<AnnotationIndex> {
  const rows = z.array(annotationRowSchema).parse(getDb().prepare(`
    SELECT session_id, plan_tool_use_id, status, title, bookmarked,
           bookmarked_at, project_path, cwd, comments, updated_at
    FROM plan_annotations
  `).all())
  const out: AnnotationIndex = new Map()
  for (const row of rows) {
    try {
      const annotation = fromRow(row)
      out.set(`${annotation.sessionId}__${annotation.planToolUseId}`, annotation)
    } catch {}
  }
  return out
}
