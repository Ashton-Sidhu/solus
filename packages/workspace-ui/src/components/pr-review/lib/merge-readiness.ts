import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { PullRequest } from '@solus/contracts/providers'

/**
 * The merge section of the activity rail says two sentences about whether this
 * pull request can land: the state, and what stands in the way. Both come from
 * here, with the "is it blocked" question, so they can never contradict each
 * other the way a "Conflicts with main / no conflicts" pair once did.
 */
export type MergeReadinessKey =
  | 'merged'
  | 'closed'
  | 'draft'
  | 'ready'
  | 'checks'
  | 'conflicts'
  | 'open'

export interface MergeReadiness {
  key: MergeReadinessKey
  headline: string
  /** The quieter second line. Empty when there is nothing worth stating. */
  note: string
  blocked: boolean
}

export interface MergeReadinessInput {
  detail: PullRequest
  checks: PrChecksSummary | undefined
  unresolvedCount: number
  openedTime: string | null
}

interface NoteInput {
  checksCurrent: boolean
  conflicted: boolean
  base: string
  unresolvedCount: number
  openedTime: string | null
}

/**
 * The second line says what to do about the headline, ordered by what stands in
 * the way: a stale result first, then the conflict, then the review.
 *
 * It deliberately says nothing about how many checks passed. The Checks section
 * sits three rows below with exactly that count in its own heading, so a note
 * like "1 of 3 checks passed" was the same sentence twice inside one rail — and
 * "1 check passed · no conflicts" restated the *headline* as well. What a check
 * count cannot say, and this line still does, is that the results are stale, or
 * that the branch needs a rebase, or that a thread is still open.
 */
function note({
  checksCurrent,
  conflicted,
  base,
  unresolvedCount,
  openedTime,
}: NoteInput): string {
  if (!checksCurrent) return 'Checks are refreshing'
  if (conflicted) return `Rebase onto ${base} to continue`
  if (unresolvedCount > 0) {
    return `${unresolvedCount} unresolved ${unresolvedCount === 1 ? 'thread' : 'threads'}`
  }
  return openedTime ? `Opened ${openedTime}` : ''
}

export function mergeReadiness({
  detail,
  checks,
  unresolvedCount,
  openedTime,
}: MergeReadinessInput): MergeReadiness {
  const checksCurrent = !checks || checks.headSha === detail.headSha
  const base = detail.baseRef ?? 'main'
  const conflicted = detail.mergeStateStatus === 'dirty' || detail.mergeable === false
  const line = note({ checksCurrent, conflicted, base, unresolvedCount, openedTime })
  const blocked = conflicted || checks?.state === 'failing'

  if (detail.state === 'merged') {
    return { key: 'merged', headline: `Merged into ${base}`, note: line, blocked: false }
  }
  if (detail.state === 'closed') {
    return { key: 'closed', headline: 'Closed', note: line, blocked: false }
  }
  if (detail.draft) {
    return { key: 'draft', headline: 'Still a draft', note: line, blocked }
  }

  const ready =
    !conflicted &&
    checks?.state !== 'failing' &&
    checks?.state !== 'pending' &&
    checksCurrent &&
    unresolvedCount === 0
  if (ready) {
    return { key: 'ready', headline: 'Ready to merge', note: line, blocked: false }
  }
  if (blocked) {
    return checks?.state === 'failing'
      ? { key: 'checks', headline: 'Checks need attention', note: line, blocked }
      : { key: 'conflicts', headline: `Conflicts with ${base}`, note: line, blocked }
  }
  return { key: 'open', headline: 'Review in progress', note: line, blocked }
}

