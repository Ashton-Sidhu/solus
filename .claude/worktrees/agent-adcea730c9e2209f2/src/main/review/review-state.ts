import type { ReviewState } from '../../shared/review'
import { artifactPath, readJson, writeJsonAtomic } from './review-store'

const STATE_SUBDIR = 'review-state'

/** Read the queued review drafts for a branch. Returns an empty store (never
 *  null) so the renderer always has a well-formed object to bind to. */
export async function readReviewState(repoRoot: string, key: string): Promise<ReviewState> {
  return (await readJson<ReviewState>(artifactPath(repoRoot, STATE_SUBDIR, key))) ?? { version: 1, key, drafts: [] }
}

/** Overwrite the review-draft store in place (atomic tmp + rename). */
export function writeReviewState(repoRoot: string, state: ReviewState): Promise<boolean> {
  return writeJsonAtomic(artifactPath(repoRoot, STATE_SUBDIR, state.key), state, `review-state ${state.key}`)
}
