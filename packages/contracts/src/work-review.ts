/**
 * Work review (docs/plans/work-review-and-live-editing.md, phase 2): people ask
 * others to review a work, and a reviewer approves it, requests changes, or
 * comments. Review is information only: it blocks nothing. A decision names the
 * exact checkpoint it applies to, and it is stale once the work's body has a
 * different hash.
 */

import { z } from 'zod'
import type { User } from './user'
import type { WorkType } from './types'

export const workReviewDecisionSchema = z.enum(['approved', 'changes_requested', 'commented'])
export type WorkReviewDecision = z.infer<typeof workReviewDecisionSchema>

/** Always derived from the current decisions, never stored. */
export type WorkReviewState = 'draft' | 'in_review' | 'changes_requested' | 'approved'

export interface WorkReviewer {
  /** `userKey` of the reviewer: an account id, or `guest:<id>` for a review link. */
  reviewerId: string
  /** The name the host stamped: the requester's directory name until the
   *  reviewer acts, then the reviewer's own admitted name. */
  displayName: string
  colorIndex: number
  /** Who asked; null for a person who reviewed through a link without a request. */
  requestedBy: User | null
  requestedAt: string | null
  requestMessage: string | null
  /** The checkpoint the current request points the reviewer at. */
  requestedRevisionId: number | null
  decision: WorkReviewDecision | null
  decisionSummary: string | null
  decidedAt: string | null
  /** The checkpoint the decision applies to. */
  decidedRevisionId: number | null
  /** The decision applies to a body that is not the current one. It stays
   *  visible, but does not count in the review state. */
  isStale: boolean
  /** A request is open: no decision yet, or a re-request after the last one. */
  isAwaiting: boolean
}

export interface WorkReview {
  workId: string
  state: WorkReviewState
  reviewers: WorkReviewer[]
}

/** A member of the work's organization, as the requester's directory names them. */
export const workReviewRequestSchema = z.object({
  reviewers: z.array(z.object({ userId: z.string().min(1), displayName: z.string().min(1).max(200) })).min(1).max(50),
  message: z.string().max(2000).optional(),
  /** The `contentVersion` of the body the requester is asking about. */
  expectedContentVersion: z.number().int().min(0),
})
export type WorkReviewRequest = z.infer<typeof workReviewRequestSchema>

/**
 * What a decision applies to: a checkpoint the reviewer opened, or the current
 * body at the version they read, which the host checkpoints first. A decision
 * is never attached to a body the reviewer did not see.
 */
export const workReviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revision'), revisionId: z.number().int().min(1) }),
  z.object({ kind: z.literal('current'), contentVersion: z.number().int().min(0) }),
])
export type WorkReviewTarget = z.infer<typeof workReviewTargetSchema>

export const workReviewDecideSchema = z.object({
  target: workReviewTargetSchema,
  decision: workReviewDecisionSchema,
  summary: z.string().max(4000).optional(),
})
export type WorkReviewDecide = z.infer<typeof workReviewDecideSchema>

/** A work that waits for the caller's review. */
export interface WorkReviewInboxItem {
  workId: string
  title: string
  type: WorkType
  requestedBy: User | null
  requestedAt: string
  requestMessage: string | null
  requestedRevisionId: number | null
  /** The caller reviewed an earlier version; "changes since my last review" compares from it. */
  lastDecidedRevisionId: number | null
}

/** The review state of each work in the caller's scope that has reviewers. */
export interface WorkReviewStateEntry {
  workId: string
  state: WorkReviewState
}

/** `workReviews.changed`: one work's reviewers changed. Read the review again by id. */
export interface WorkReviewsChanged {
  workId: string
  change: 'requested' | 'decided' | 'removed'
  /** The reviewers the change is about. */
  reviewerIds: string[]
  /** Who made the change, as the host admitted them. */
  by: User | null
}

/**
 * The work's overall state from its reviewers' current decisions: any current
 * `changes_requested` wins; otherwise any current `approved`; with reviewers
 * but neither, it is in review; with none, it is a draft.
 */
export function deriveWorkReviewState(reviewers: readonly Pick<WorkReviewer, 'decision' | 'isStale'>[]): WorkReviewState {
  if (reviewers.length === 0) return 'draft'
  const current = reviewers.filter((reviewer) => !reviewer.isStale)
  if (current.some((reviewer) => reviewer.decision === 'changes_requested')) return 'changes_requested'
  if (current.some((reviewer) => reviewer.decision === 'approved')) return 'approved'
  return 'in_review'
}
