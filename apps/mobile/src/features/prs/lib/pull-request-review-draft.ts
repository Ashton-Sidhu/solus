// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestReviewDrafts.ts and pullRequestDiffComments.ts (MIT, see UPSTREAM.md).
import type { DraftReview, DraftReviewComment, PrReviewVerdict } from '@solus/contracts/providers'
import { OFFLINE_REASON } from '../detail/pull-request-view'

/**
 * The review draft: the inline comments a person writes on the diff, and the
 * review summary, before they submit one review. A comment is anchored to the
 * head it was written on; after a push it no longer goes with the review.
 */

export interface PendingReviewComment extends DraftReviewComment {
  id: string
  /** The head the comment was written on. */
  headSha: string
}

export interface ReviewDraft {
  summary: string
  comments: PendingReviewComment[]
}

export const EMPTY_REVIEW_DRAFT: ReviewDraft = { summary: '', comments: [] }

const VERDICT_EVENTS = {
  comment: 'COMMENT',
  approve: 'APPROVE',
  'request-changes': 'REQUEST_CHANGES',
} as const satisfies Record<PrReviewVerdict, DraftReview['event']>

export function isReviewDraftEmpty(draft: ReviewDraft): boolean {
  return draft.summary.trim() === '' && draft.comments.length === 0
}

/** The comments that go with a review of `headSha`. */
export function currentReviewComments(draft: ReviewDraft, headSha: string): PendingReviewComment[] {
  return draft.comments.filter((comment) => comment.headSha === headSha)
}

/** The comments written on an older head: kept, but not sent. */
export function outdatedReviewComments(draft: ReviewDraft, headSha: string): PendingReviewComment[] {
  return draft.comments.filter((comment) => comment.headSha !== headSha)
}

/** The review the host submits: the verdict, the summary, and each comment
 *  written on the head the person was shown. A single-line comment sends no
 *  `startLine`. */
export function draftReview(input: { verdict: PrReviewVerdict; body: string; comments: readonly PendingReviewComment[]; headSha: string; baseSha?: string }): DraftReview {
  const review: DraftReview = {
    body: input.body.trim(),
    event: VERDICT_EVENTS[input.verdict],
    commitId: input.headSha,
    comments: input.comments
      .filter((comment) => comment.headSha === input.headSha)
      .map(({ path, line, startLine, side, body }): DraftReviewComment => (
        startLine !== undefined && startLine !== line
          ? { path, line, startLine, side, body: body.trim() }
          : { path, line, side, body: body.trim() })),
  }
  if (input.baseSha) review.baseSha = input.baseSha
  return review
}

/** A successful submit clears only what it sent. A summary or a comment
 *  changed while the request ran stays. */
export function clearSubmittedReview(current: ReviewDraft, submitted: ReviewDraft): ReviewDraft {
  return {
    summary: current.summary === submitted.summary ? '' : current.summary,
    comments: current.comments.filter((comment) => !submitted.comments.some((sent) =>
      sent.id === comment.id
      && sent.body === comment.body
      && sent.headSha === comment.headSha
      && sent.path === comment.path
      && sent.side === comment.side
      && sent.line === comment.line
      && sent.startLine === comment.startLine)),
  }
}

/**
 * Whether a review comment can be saved. A draft is the person's own text on
 * this device; writing one needs only the right to comment inline when it is
 * new. A new comment also needs the head it was selected on.
 */
export function canSaveReviewComment(input: {
  readonly body: string
  readonly isSaved: boolean
  readonly stale: boolean
  readonly canInlineComment: boolean
  readonly connected: boolean
}): boolean {
  if (input.body.trim().length === 0) return false
  return input.isSaved || (!input.stale && (input.canInlineComment || !input.connected))
}

/** "Line 12", "Lines 10–12", or "Old line 7" for a comment on the old side. */
export function reviewCommentLabel(comment: Pick<DraftReviewComment, 'side' | 'line' | 'startLine'>): string {
  const old = comment.side === 'LEFT' ? 'Old line' : 'Line'
  if (comment.startLine !== undefined && comment.startLine !== comment.line) return `${old}s ${comment.startLine}–${comment.line}`
  return `${old} ${comment.line}`
}

/**
 * Whether the review or the comment has what it needs to be sent. A review
 * needs a verdict; a review that does not approve also needs a summary or a
 * line comment. A comment needs text and the right to comment.
 */
export function canSubmitReview(input: {
  readonly reviewing: boolean
  readonly verdict: PrReviewVerdict | undefined
  readonly body: string
  readonly currentCount: number
  readonly canComment: boolean
}): boolean {
  const hasBody = input.body.trim().length > 0
  if (!input.reviewing) return input.canComment && hasBody
  return input.verdict !== undefined && (input.verdict === 'approve' || hasBody || input.currentCount > 0)
}

/** Why the person cannot send the review or the comment; null when nothing stops it. */
export function reviewBlockedReason(input: {
  readonly connected: boolean
  readonly hasPullRequest: boolean
  readonly reviewing: boolean
  readonly verdictCount: number
  readonly canComment: boolean
}): string | null {
  if (!input.connected) return OFFLINE_REASON
  if (!input.hasPullRequest) return null
  if (input.reviewing && input.verdictCount === 0) return 'Your account cannot review this pull request.'
  if (!input.reviewing && !input.canComment) return 'Your account cannot comment on this pull request.'
  return null
}

/** The label of the button that sends the review or the comment. */
export function reviewSubmitLabel(busy: boolean, reviewing: boolean, verdict: PrReviewVerdict | undefined): string {
  if (busy) return 'Submitting…'
  if (!reviewing) return 'Post comment'
  if (verdict === 'approve') return 'Approve'
  return verdict === 'request-changes' ? 'Request changes' : 'Submit review'
}
