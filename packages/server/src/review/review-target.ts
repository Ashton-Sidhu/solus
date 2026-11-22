import type { IpcContext } from '@solus/contracts/types'
import { createHash } from 'node:crypto'
/** The session whose changes a review reads: the context's session, once it
 *  has run. Its snapshots are stored under its session id
 *  (docs/plans/session-identity.md). */
export function reviewedSessionId(ctx: Pick<IpcContext, 'session'>): string | null {
  return ctx.session.agentSessionId ? ctx.session.sessionId : null
}

/** Content revision for dedupe and staleness. Patch hashing means staged,
 * unstaged, and untracked changes invalidate a guide without moving HEAD. */
export function fingerprintReviewPatch(patch: string): string {
  return createHash('sha256').update(patch).digest('hex')
}
