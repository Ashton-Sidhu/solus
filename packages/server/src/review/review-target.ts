import type { IpcContext } from '@solus/contracts/types'
import { createHash } from 'node:crypto'
import {
  reviewGuideKeyForTarget,
  type ReviewContext,
  type ReviewGuideRequestOptions,
  type ReviewTarget,
} from '@solus/contracts/review'

/** The session whose changes a review reads: the context's session, once it
 *  has run. Its snapshots are stored under its session id
 *  (docs/plans/session-identity.md). */
export function reviewedSessionId(ctx: Pick<IpcContext, 'session'>): string | null {
  return ctx.session.agentSessionId ? ctx.session.sessionId : null
}

export function normalizedReviewTarget(
  opts: Pick<ReviewGuideRequestOptions, 'target' | 'scope'>,
  sessionId: string | null,
): ReviewTarget {
  if (opts.target) return opts.target
  if (opts.scope === 'session') {
    return sessionId ? { kind: 'session', sessionId } : { kind: 'session' }
  }
  // Old callers keep the established branch behavior. New `/review` requests
  // always send an explicit working-tree target.
  return { kind: 'branch' }
}

export function guideKeyForTarget(
  review: Pick<ReviewContext, 'branch'>,
  target: ReviewTarget,
  sessionId: string | null,
): string {
  return reviewGuideKeyForTarget(target, review.branch, sessionId)
}

/** Content revision for dedupe and staleness. Patch hashing means staged,
 * unstaged, and untracked changes invalidate a guide without moving HEAD. */
export function fingerprintReviewPatch(patch: string): string {
  return createHash('sha256').update(patch).digest('hex')
}
