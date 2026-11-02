import { sql } from 'drizzle-orm'
import type { PlanAnnotations } from '@solus/contracts/types'
import type { Attribution } from '@solus/contracts/user'
import type { CommentActor, WorkCommentCommand } from '@solus/contracts/comment-commands'
import { getDatabase, type Db } from '../db/database'
import { scopeAdmits, type RecordScope } from '../admission/principal'
import { scopeClause } from '../data/scope'
import { organizationOfSession } from '../data/sessions/session-records'
import { z } from 'zod'
import { workExternalLinkSchema } from '../docs/schema'
import { planAnnotations } from './schema'
import { commentThreads } from '../data/comments/schema'
import {
  applyThreadCommand,
  readComments,
  reconcileThreads,
  threadsUpdatedAt,
  type ThreadSubject,
} from '../data/comments/comment-threads'

/**
 * A plan's review state: the `plan_annotations` row holds its status, title,
 * bookmark, and mirror link; its comment threads are `comment_threads` rows
 * under the same durable identity (plans/029 §5.2), so a rebuild of the plan
 * index never touches them. The wire still carries both as one `PlanAnnotations`.
 */

/** A plan's annotations without its threads, with how many it has: what the plan index reads. */
export type PlanAnnotationSummary = Omit<PlanAnnotations, 'comments'> & { commentCount: number }

/** The metadata a write carries: everything of the annotations but the threads. */
type PlanAnnotationMetadata = Omit<PlanAnnotations, 'comments'>

const annotationRowSchema = z.object({
  session_id: z.string(),
  plan_tool_use_id: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  title: z.string(),
  bookmarked: z.number(),
  bookmarked_at: z.number().nullable(),
  project_path: z.string(),
  cwd: z.string(),
  mirrored_doc: z.string().nullable(),
  updated_at: z.number(),
  organization_id: z.string(),
})

type AnnotationRow = z.infer<typeof annotationRowSchema>

const ANNOTATION_COLUMNS = sql`
  session_id, plan_tool_use_id, status, title, bookmarked,
  bookmarked_at, project_path, cwd, mirrored_doc, updated_at, organization_id
`

function threadsOf(organizationId: string, sessionId: string, planToolUseId: string): ThreadSubject {
  return { organizationId, kind: 'plan', id: sessionId, part: planToolUseId }
}

function summaryFromRow(row: AnnotationRow, commentCount: number): PlanAnnotationSummary {
  const summary: PlanAnnotationSummary = {
    version: 1,
    sessionId: row.session_id,
    projectPath: row.project_path,
    cwd: row.cwd,
    planToolUseId: row.plan_tool_use_id,
    title: row.title,
    status: row.status,
    commentCount,
    bookmarked: row.bookmarked === 1,
    updatedAt: row.updated_at,
  }
  if (row.bookmarked_at !== null) summary.bookmarkedAt = row.bookmarked_at
  if (row.mirrored_doc) summary.mirroredDoc = workExternalLinkSchema.parse(JSON.parse(row.mirrored_doc))
  return summary
}

/** The row with its threads. `updatedAt` is the newest change to either, on this host's clock. */
async function annotationsFromRow(db: Db, row: AnnotationRow): Promise<PlanAnnotations> {
  const subject = threadsOf(row.organization_id, row.session_id, row.plan_tool_use_id)
  const { commentCount: _count, ...metadata } = summaryFromRow(row, 0)
  return {
    ...metadata,
    comments: await readComments(db, subject),
    updatedAt: Math.max(row.updated_at, await threadsUpdatedAt(db, subject)),
  }
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

/** Upsert the plan's metadata. The threads are not here; the position counter is kept as it is. */
async function writeMetadata(db: Db, organizationId: string, ann: PlanAnnotationMetadata): Promise<void> {
  await db.run(sql`
    INSERT INTO ${planAnnotations} (
      session_id, plan_tool_use_id, status, title, bookmarked,
      bookmarked_at, project_path, cwd, mirrored_doc, updated_at, organization_id
    ) VALUES (
      ${ann.sessionId}, ${ann.planToolUseId}, ${ann.status}, ${ann.title}, ${ann.bookmarked ? 1 : 0},
      ${ann.bookmarkedAt ?? null}, ${ann.projectPath}, ${ann.cwd},
      ${ann.mirroredDoc ? JSON.stringify(ann.mirroredDoc) : null}, ${ann.updatedAt}, ${organizationId}
    )
    ON CONFLICT(session_id, plan_tool_use_id) DO UPDATE SET
      status = excluded.status,
      title = excluded.title,
      bookmarked = excluded.bookmarked,
      bookmarked_at = excluded.bookmarked_at,
      project_path = excluded.project_path,
      cwd = excluded.cwd,
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
    const db = getDatabase()
    const row = await annotationRow(db, scope, sessionId, planToolUseId)
    return row ? await annotationsFromRow(db, row) : null
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

/**
 * A client's whole copy of the plan's annotations. The metadata is written as
 * sent; the threads are reconciled one by one against the copy's `updatedAt`,
 * the state it was read at (`reconcileThreads`), so a copy that never saw a
 * thread cannot delete it. `by` is who sends it: the author of what the copy
 * has not stamped, and whose own threads it may still delete.
 */
export async function saveAnnotations(scope: RecordScope, ann: PlanAnnotations, by: Attribution = { kind: 'system' }): Promise<void> {
  const organizationId = await organizationOfPlan(scope, ann.sessionId, ann.planToolUseId)
  await getDatabase().transaction(async (db) => {
    const now = Date.now()
    await writeMetadata(db, organizationId, { ...ann, updatedAt: now })
    await reconcileThreads(db, threadsOf(organizationId, ann.sessionId, ann.planToolUseId), ann.comments, { snapshotAt: ann.updatedAt, by, now })
  })
}

/**
 * One command on a plan's threads, as an agent's tool sends it. A plan nobody
 * has annotated yet has no row: `ensure` is the metadata that makes one, so the
 * first comment on a plan works as the first comment from a person's rail does.
 */
export async function applyPlanComment(
  scope: RecordScope,
  sessionId: string,
  planToolUseId: string,
  command: WorkCommentCommand,
  actor: CommentActor,
  ensure?: PlanAnnotationMetadata,
): Promise<void> {
  const organizationId = await organizationOfPlan(scope, sessionId, planToolUseId)
  await getDatabase().transaction(async (db) => {
    if (ensure && !await annotationRow(db, organizationId, sessionId, planToolUseId)) await writeMetadata(db, organizationId, ensure)
    await applyThreadCommand(db, threadsOf(organizationId, sessionId, planToolUseId), command, actor)
  })
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
    const existing = row ? summaryFromRow(row, 0) : null
    const bookmarked = !existing?.bookmarked
    const merged: PlanAnnotationMetadata = {
      version: 1,
      sessionId,
      projectPath,
      cwd,
      planToolUseId,
      title: existing?.title || title,
      status: existing?.status ?? 'pending',
      bookmarked,
      updatedAt: Date.now(),
    }
    if (bookmarked) merged.bookmarkedAt = Date.now()
    if (existing?.mirroredDoc) merged.mirroredDoc = existing.mirroredDoc
    await writeMetadata(db, organizationId, merged)
    return { ...merged, comments: await readComments(db, threadsOf(organizationId, sessionId, planToolUseId)) }
  })
}

export type AnnotationIndex = Map<string, PlanAnnotationSummary>

const threadCountRowSchema = z.object({ organization_id: z.string(), subject_id: z.string(), subject_part: z.string(), count: z.coerce.number() })

/** Load every annotation into a map keyed by `${sessionId}__${planToolUseId}`. Used once by the indexer. */
export async function loadAllAnnotations(scope: RecordScope): Promise<AnnotationIndex> {
  const db = getDatabase()
  const rows = z.array(annotationRowSchema).parse(await db.all(sql`
    SELECT ${ANNOTATION_COLUMNS}
    FROM ${planAnnotations}
    WHERE ${scopeClause(scope)}
  `))
  const counts = new Map<string, number>()
  for (const row of threadCountRowSchema.array().parse(await db.all(sql`
    SELECT organization_id, subject_id, subject_part, COUNT(*) AS count FROM ${commentThreads}
    WHERE subject_kind = 'plan' AND ${scopeClause(scope)}
    GROUP BY organization_id, subject_id, subject_part
  `))) {
    counts.set(`${row.organization_id}\0${row.subject_id}\0${row.subject_part}`, row.count)
  }
  const out: AnnotationIndex = new Map()
  for (const row of rows) {
    try {
      const annotation = summaryFromRow(row, counts.get(`${row.organization_id}\0${row.session_id}\0${row.plan_tool_use_id}`) ?? 0)
      out.set(`${annotation.sessionId}__${annotation.planToolUseId}`, annotation)
    } catch {}
  }
  return out
}
