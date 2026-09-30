import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  deriveWorkReviewState,
  workReviewDecisionSchema,
  type WorkReview,
  type WorkReviewDecide,
  type WorkReviewer,
  type WorkReviewInboxItem,
  type WorkReviewRequest,
  type WorkReviewsChanged,
  type WorkReviewStateEntry,
} from '@solus/contracts/work-review'
import { userColorIndex, userKey, userSchema, type User } from '@solus/contracts/user'
import { afterDatabaseCommit, getDatabase, type Db } from '../../db/database'
import type { Principal, RecordScope } from '../../admission/principal'
import type { ShareManager } from '../../sharing/share-manager'
import { scopeClause } from '../scope'
import { workReviewers, works } from './schema'
import { Work } from './work'
import { isoTime, workTypeSchema } from './work-rows'

/**
 * Who reviews a work and what they decided (docs/plans/work-review-and-live-editing.md,
 * phase 2). One row per reviewer. The review state and each decision's staleness
 * are derived on read from the decision's content hash and the work's current
 * hash, so an edit that is undone makes an approval current again.
 *
 * Review is information only: nothing here blocks a write, a publish, or an agent.
 */

const reviewerRowSchema = z.object({
  reviewer_id: z.string(),
  display_name: z.string(),
  color_index: z.number(),
  requested_by: z.string().nullable(),
  requested_at: z.number().nullable(),
  request_message: z.string().nullable(),
  requested_rev: z.number().nullable(),
  decision: workReviewDecisionSchema.nullable(),
  decision_summary: z.string().nullable(),
  decided_at: z.number().nullable(),
  decided_rev: z.number().nullable(),
  decided_content_hash: z.string().nullable(),
})
type ReviewerRow = z.infer<typeof reviewerRowSchema>

const REVIEWER_COLUMNS = sql.raw('reviewer_id, display_name, color_index, requested_by, requested_at, request_message, requested_rev, decision, decision_summary, decided_at, decided_rev, decided_content_hash')

function parseUser(json: string | null): User | null {
  if (!json) return null
  const parsed = userSchema.safeParse(JSON.parse(json))
  return parsed.success ? parsed.data : null
}

function reviewerFromRow(row: ReviewerRow, currentHash: string): WorkReviewer {
  const isAwaiting = row.requested_at !== null && (row.decided_at === null || row.requested_at > row.decided_at)
  return {
    reviewerId: row.reviewer_id,
    displayName: row.display_name,
    colorIndex: row.color_index,
    requestedBy: parseUser(row.requested_by),
    requestedAt: row.requested_at === null ? null : isoTime(row.requested_at),
    requestMessage: row.request_message,
    requestedRevisionId: row.requested_rev,
    decision: row.decision,
    decisionSummary: row.decision_summary,
    decidedAt: row.decided_at === null ? null : isoTime(row.decided_at),
    decidedRevisionId: row.decided_rev,
    isStale: row.decision !== null && row.decided_content_hash !== currentHash,
    isAwaiting,
  }
}

type ReviewsChangedListener = (change: WorkReviewsChanged) => void
const listeners = new Set<ReviewsChangedListener>()

/** Subscribe to every committed change to a work's reviewers. */
export function onWorkReviewsChanged(listener: ReviewsChangedListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitReviewsChanged(change: WorkReviewsChanged): void {
  void afterDatabaseCommit(async () => {
    for (const listener of listeners) listener(change)
  })
}

async function reviewerRows(db: Db, workId: string): Promise<ReviewerRow[]> {
  return reviewerRowSchema.array().parse(await db.all(sql`
    SELECT ${REVIEWER_COLUMNS} FROM ${workReviewers} WHERE work_id = ${workId} ORDER BY COALESCE(requested_at, decided_at), reviewer_id
  `))
}

/** The work's reviewers, their decisions against its current body, and its state. */
export async function loadWorkReview(scope: RecordScope, workId: string): Promise<WorkReview> {
  const work = await Work.byId(scope, workId)
  const reviewers = (await reviewerRows(getDatabase(), work.id)).map((row) => reviewerFromRow(row, work.contentHash))
  return { workId: work.id, state: deriveWorkReviewState(reviewers), reviewers }
}

/**
 * Ask people to review the body the requester read. The body is checkpointed
 * as a `review` revision, and each request points at it. Asking again keeps
 * the reviewer's last decision, so they can see the changes since it.
 */
export async function requestWorkReview(scope: RecordScope, workId: string, input: WorkReviewRequest, by: User | null): Promise<WorkReview> {
  const work = await Work.byId(scope, workId)
  await getDatabase().transaction(async (db) => {
    const revision = await work.checkpoint({ reason: 'review', expectedContentVersion: input.expectedContentVersion })
    const existing = new Map((await reviewerRows(db, work.id)).map((row) => [row.reviewer_id, row]))
    for (const reviewer of input.reviewers) {
      // A request is newer than the decision it follows, even within one millisecond.
      const now = Math.max(Date.now(), (existing.get(reviewer.userId)?.decided_at ?? 0) + 1)
      const colorIndex = userColorIndex({ id: { kind: 'account', accountId: reviewer.userId }, displayName: reviewer.displayName })
      await db.run(sql`
        INSERT INTO ${workReviewers} (work_id, reviewer_id, display_name, color_index, requested_by, requested_at, request_message, requested_rev, organization_id)
        VALUES (${work.id}, ${reviewer.userId}, ${reviewer.displayName}, ${colorIndex}, ${by ? JSON.stringify(by) : null}, ${now}, ${input.message ?? null}, ${revision.revisionId}, ${work.organizationId})
        ON CONFLICT (work_id, reviewer_id) DO UPDATE SET
          requested_by = excluded.requested_by,
          requested_at = excluded.requested_at,
          request_message = excluded.request_message,
          requested_rev = excluded.requested_rev
      `)
    }
    emitReviewsChanged({ workId: work.id, change: 'requested', reviewerIds: input.reviewers.map((reviewer) => reviewer.userId), by })
  })
  return loadWorkReview(scope, workId)
}

/** Take a reviewer off the work, with their decision. */
export async function removeWorkReviewer(scope: RecordScope, workId: string, reviewerId: string, by: User | null): Promise<WorkReview> {
  const work = await Work.byId(scope, workId)
  await getDatabase().transaction(async (db) => {
    await db.run(sql`DELETE FROM ${workReviewers} WHERE work_id = ${work.id} AND reviewer_id = ${reviewerId}`)
    emitReviewsChanged({ workId: work.id, change: 'removed', reviewerIds: [reviewerId], by })
  })
  return loadWorkReview(scope, workId)
}

/**
 * Record the reviewer's decision on the exact body they saw: a checkpoint they
 * opened, or the current body at the version they read, which is checkpointed
 * first and refused if it moved. A decision on an older checkpoint is kept,
 * and is stale at once. The newest decision replaces the reviewer's older one.
 * The reviewer is the admitted person; a client never names itself.
 */
export async function decideWorkReview(scope: RecordScope, workId: string, input: WorkReviewDecide, reviewer: User): Promise<WorkReview> {
  const work = await Work.byId(scope, workId)
  await getDatabase().transaction(async (db) => {
    const revision = input.target.kind === 'revision'
      ? await work.revision(input.target.revisionId)
      : await work.checkpoint({ reason: 'review', expectedContentVersion: input.target.contentVersion })
    const reviewerId = userKey(reviewer.id)
    // A decision is newer than the request it answers, even within one millisecond.
    const prior = (await reviewerRows(db, work.id)).find((row) => row.reviewer_id === reviewerId)
    const now = Math.max(Date.now(), (prior?.requested_at ?? 0) + 1)
    await db.run(sql`
      INSERT INTO ${workReviewers} (work_id, reviewer_id, display_name, color_index, decision, decision_summary, decided_at, decided_rev, decided_content_hash, organization_id)
      VALUES (${work.id}, ${reviewerId}, ${reviewer.displayName}, ${userColorIndex(reviewer)}, ${input.decision}, ${input.summary?.trim() || null}, ${now}, ${revision.revisionId}, ${revision.contentHash}, ${work.organizationId})
      ON CONFLICT (work_id, reviewer_id) DO UPDATE SET
        display_name = excluded.display_name,
        color_index = excluded.color_index,
        decision = excluded.decision,
        decision_summary = excluded.decision_summary,
        decided_at = excluded.decided_at,
        decided_rev = excluded.decided_rev,
        decided_content_hash = excluded.decided_content_hash
    `)
    emitReviewsChanged({ workId: work.id, change: 'decided', reviewerIds: [reviewerId], by: reviewer })
  })
  return loadWorkReview(scope, workId)
}

const inboxRowSchema = z.object({
  work_id: z.string(),
  title: z.string().nullable(),
  type: workTypeSchema.nullable(),
  requested_by: z.string().nullable(),
  requested_at: z.number(),
  request_message: z.string().nullable(),
  requested_rev: z.number().nullable(),
  decided_rev: z.number().nullable(),
})

/** The works that wait for this reviewer: requested, and not decided since. */
export async function workReviewInbox(scope: RecordScope, reviewerId: string): Promise<WorkReviewInboxItem[]> {
  const rows = inboxRowSchema.array().parse(await getDatabase().all(sql`
    SELECT r.work_id, w.title, w.type, r.requested_by, r.requested_at, r.request_message, r.requested_rev, r.decided_rev
    FROM ${workReviewers} r JOIN ${works} w ON w.id = r.work_id
    WHERE r.reviewer_id = ${reviewerId} AND r.requested_at IS NOT NULL
      AND (r.decided_at IS NULL OR r.requested_at > r.decided_at)
      AND ${scopeClause(scope, sql.raw('w.organization_id'))}
    ORDER BY r.requested_at DESC
  `))
  return rows.map((row) => ({
    workId: row.work_id,
    title: row.title ?? 'Untitled',
    type: row.type ?? 'doc',
    requestedBy: parseUser(row.requested_by),
    requestedAt: isoTime(row.requested_at),
    requestMessage: row.request_message,
    requestedRevisionId: row.requested_rev,
    lastDecidedRevisionId: row.decided_rev,
  }))
}

const stateRowSchema = z.object({
  work_id: z.string(),
  content_hash: z.string(),
  decision: workReviewDecisionSchema.nullable(),
  decided_content_hash: z.string().nullable(),
})

/** The review state of every work in scope that has reviewers, for the gallery. */
export async function workReviewStates(scope: RecordScope): Promise<WorkReviewStateEntry[]> {
  const rows = stateRowSchema.array().parse(await getDatabase().all(sql`
    SELECT r.work_id, w.content_hash, r.decision, r.decided_content_hash
    FROM ${workReviewers} r JOIN ${works} w ON w.id = r.work_id
    WHERE ${scopeClause(scope, sql.raw('w.organization_id'))}
  `))
  const byWork = new Map<string, { decision: WorkReviewer['decision']; isStale: boolean }[]>()
  for (const row of rows) {
    const list = byWork.get(row.work_id) ?? []
    list.push({ decision: row.decision, isStale: row.decision !== null && row.decided_content_hash !== row.content_hash })
    byWork.set(row.work_id, list)
  }
  return [...byWork].map(([workId, reviewers]) => ({ workId, state: deriveWorkReviewState(reviewers) }))
}

/**
 * A reviewer who cannot open the work yet is given it as a commenter: they can
 * read, comment, and decide, but not edit. A person already on the list, or a
 * work shared with the whole organization, keeps the access it has.
 */
export async function shareWithReviewers(shares: ShareManager | undefined, principal: Principal, workId: string, reviewerIds: readonly string[]): Promise<void> {
  if (!shares) return
  const resource = { kind: 'work', id: workId } as const
  const list = await shares.list(resource, principal)
  const owner = list.ownerUserId
  if (list.grants.some((grant) => grant.subject.kind === 'organization')) return
  const listed = new Set(list.grants.filter((grant) => grant.subject.kind === 'user').map((grant) => grant.subject.id))
  const added = reviewerIds.filter((reviewerId) => reviewerId !== owner && !listed.has(reviewerId))
  if (added.length === 0) return
  await shares.setGrants({
    resource,
    grants: [
      ...list.grants.map((grant) => ({ subject: grant.subject, role: grant.role })),
      ...added.map((reviewerId) => ({ subject: { kind: 'user' as const, id: reviewerId }, role: 'commenter' as const })),
    ],
  }, principal)
}
