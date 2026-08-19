import { reviewGuideKeyFor, type ReviewContext } from '@solus/contracts/review'

/** Stable storage identity for the latest point-in-time guide. Diff bases are
 * metadata inside the guide, not part of its filename: regenerating a branch or
 * session review overwrites the same JSON file. */
export function guideKeyFor(
  review: Pick<ReviewContext, 'branch'>,
  scope: 'branch' | 'session' | undefined,
  sessionId: string | null,
): string {
  return reviewGuideKeyFor(review.branch, scope, sessionId)
}
