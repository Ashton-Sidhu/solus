import { sql } from 'drizzle-orm'
import type { PlanAnnotations } from '@solus/contracts/types'
import { getDatabase, type Db } from '../db/database'
import { scopeAdmits, type RecordScope } from '../admission/principal'
import { scopeClause } from '../data/scope'
import { organizationOfSession } from '../data/sessions/session-records'
import { z } from 'zod'
import { workExternalLinkSchema } from '../docs/schema'
import { planAnnotations } from './schema'
import { attributionSchema } from '@solus/contracts/user'
import { readStoredComments, type StoredThread } from '../annotations/stored-comments'
import { hostUser } from '../host/host-user'

const commentReplySchema = z.object({
  id: z.string(),
  author: attributionSchema.optional(),
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
  author: attributionSchema.optional(),
  createdAt: z.number().optional(),
  resolvedAt: z.number().optional(),
  resolvedBy: attributionSchema.optional(),
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
  mirrored_doc: z.string().nullable(),
  updated_at: z.number(),
})

type AnnotationRow = z.infer<typeof annotationRowSchema>

const ANNOTATION_COLUMNS = sql`
  session_id, plan_tool_use_id, status, title, bookmarked,
  bookmarked_at, project_path, cwd, comments, mirrored_doc, updated_at
`

function fromRow(row: AnnotationRow): PlanAnnotations {
  const annotation: PlanAnnotations = {
    version: 1,
    sessionId: row.session_id,
    projectPath: row.project_path,
    cwd: row.cwd,
    planToolUseId: row.plan_tool_use_id,
    title: row.title,
    status: row.status,
    // SAFETY: `writeAnnotations` is the sole writer and stores `StoredThread[]`; the wire shape is checked below.
    comments: z.array(planCommentSchema).parse(readStoredComments(JSON.parse(row.comments) as StoredThread[], hostUser())),
    bookmarked: row.bookmarked === 1,
    updatedAt: row.updated_at,
  }
  if (row.bookmarked_at !== null) annotation.bookmarkedAt = row.bookmarked_at
  if (row.mirrored_doc) annotation.mirroredDoc = workExternalLinkSchema.parse(JSON.parse(row.mirrored_doc))
  return annotation
}

async function annotationRow(
  db: Db,
  scope: RecordScope,
  sessionId: string,
  planToolUseId: string,
): Promise<AnnotationRow | undefined> {
  const parsed = annotationRowSchema.safeParse(await db.get(sql`
    SELECT ${ANNOTATION_COLUMNS}
    FROM ${planAnnotations}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId} AND plan_tool_use_id = ${planToolUseId}
  `))
  return parsed.success ? parsed.data : undefined
}

async function writeAnnotations(db: Db, organizationId: string, ann: PlanAnnotations): Promise<void> {
  await db.run(sql`
    INSERT INTO ${planAnnotations} (
      session_id, plan_tool_use_id, status, title, bookmarked,
      bookmarked_at, project_path, cwd, comments, mirrored_doc, updated_at, organization_id
    ) VALUES (
      ${ann.sessionId}, ${ann.planToolUseId}, ${ann.status}, ${ann.title}, ${ann.bookmarked ? 1 : 0},
      ${ann.bookmarkedAt ?? null}, ${ann.projectPath}, ${ann.cwd}, ${JSON.stringify(ann.comments)},
      ${ann.mirroredDoc ? JSON.stringify(ann.mirroredDoc) : null}, ${ann.updatedAt}, ${organizationId}
    )
    ON CONFLICT(session_id, plan_tool_use_id) DO UPDATE SET
      status = excluded.status,
      title = excluded.title,
      bookmarked = excluded.bookmarked,
      bookmarked_at = excluded.bookmarked_at,
      project_path = excluded.project_path,
      cwd = excluded.cwd,
      comments = excluded.comments,
      mirrored_doc = excluded.mirrored_doc,
      updated_at = excluded.updated_at,
      organization_id = excluded.organization_id
  `)
}

export async function loadAnnotations(
  scope: RecordScope,
  sessionId: string,
  planToolUseId: string,
): Promise<PlanAnnotations | null> {
  try {
    const row = await annotationRow(getDatabase(), scope, sessionId, planToolUseId)
    return row ? fromRow(row) : null
  } catch {
    return null
  }
}

/** A plan's annotations belong to its session's organization (organization-scope §3). */
async function organizationOfPlan(scope: RecordScope, sessionId: string, planToolUseId: string): Promise<string> {
  const row = z.object({ organization_id: z.string() }).nullish().parse(await getDatabase().get(sql`
    SELECT organization_id FROM ${planAnnotations}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId} AND plan_tool_use_id = ${planToolUseId}
  `))
  if (row) return row.organization_id
  const organizationId = await organizationOfSession(sessionId)
  if (!scopeAdmits(scope, organizationId)) throw new Error('This plan is not in your organization.')
  return organizationId
}

export async function saveAnnotations(scope: RecordScope, ann: PlanAnnotations): Promise<void> {
  const merged: PlanAnnotations = { ...ann, updatedAt: Date.now() }
  await writeAnnotations(getDatabase(), await organizationOfPlan(scope, ann.sessionId, ann.planToolUseId), merged)
}

export async function toggleBookmarkAnnotations(
  scope: RecordScope,
  sessionId: string,
  projectPath: string,
  cwd: string,
  planToolUseId: string,
  title: string,
): Promise<PlanAnnotations> {
  const organizationId = await organizationOfPlan(scope, sessionId, planToolUseId)
  return getDatabase().transaction(async (db) => {
    const row = await annotationRow(db, organizationId, sessionId, planToolUseId)
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
    if (existing?.mirroredDoc) merged.mirroredDoc = existing.mirroredDoc
    await writeAnnotations(db, organizationId, merged)
    return merged
  })
}

export type AnnotationIndex = Map<string, PlanAnnotations>

/** Load every annotation into a map keyed by `${sessionId}__${planToolUseId}`. Used once by the indexer. */
export async function loadAllAnnotations(scope: RecordScope): Promise<AnnotationIndex> {
  const rows = z.array(annotationRowSchema).parse(await getDatabase().all(sql`
    SELECT ${ANNOTATION_COLUMNS}
    FROM ${planAnnotations}
    WHERE ${scopeClause(scope)}
  `))
  const out: AnnotationIndex = new Map()
  for (const row of rows) {
    try {
      const annotation = fromRow(row)
      out.set(`${annotation.sessionId}__${annotation.planToolUseId}`, annotation)
    } catch {}
  }
  return out
}
