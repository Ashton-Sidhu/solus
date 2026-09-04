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
  | 'behind'
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
  approvedReviewCount: number
  openedTime: string | null
}

interface NoteInput {
  checksCurrent: boolean
  checksState: PrChecksSummary['state'] | undefined
  conflicted: boolean
  base: string
  unresolvedCount: number
  requiredApprovingReviewCount: number | null
  approvedReviewCount: number
  mergeStateStatus: string | null
  openedTime: string | null
}

function hostCanMerge(detail: PullRequest): boolean {
  return (
    detail.mergeable === true &&
    (detail.mergeStateStatus === 'clean' || detail.mergeStateStatus === 'has_hooks')
  )
}

function checksNeedAttention(
  checks: PrChecksSummary | undefined,
  mergeStateStatus: string | null,
): boolean {
  return checks?.state === 'failing' || mergeStateStatus === 'unstable'
}

function mergeStatusPending(mergeStateStatus: string | null): boolean {
  return mergeStateStatus === null || mergeStateStatus === 'unknown'
}

/**
 * The second line says what to do about the headline, ordered by what stands in
 * the way: a stale result first, then branch and review requirements.
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
  checksState,
  conflicted,
  base,
  unresolvedCount,
  requiredApprovingReviewCount,
  approvedReviewCount,
  mergeStateStatus,
  openedTime,
}: NoteInput): string {
  if (!checksCurrent) return 'Checks are refreshing'
  if (conflicted) return `Rebase onto ${base} to continue`
  if (mergeStateStatus === 'behind') return `Update this branch with ${base}`
  if (unresolvedCount > 0) {
    return `${unresolvedCount} unresolved ${unresolvedCount === 1 ? 'thread' : 'threads'}`
  }
  if (requiredApprovingReviewCount !== null) {
    const remaining = Math.max(requiredApprovingReviewCount - approvedReviewCount, 0)
    if (remaining > 0) {
      return `${remaining} approving ${remaining === 1 ? 'review' : 'reviews'} required`
    }
  }
  if (checksState === 'failing' || mergeStateStatus === 'unstable') {
    return 'Fix failing checks to continue'
  }
  if (checksState === 'pending') return 'Wait for checks to finish'
  if (mergeStateStatus === 'blocked') return 'Merge requirements are still pending'
  if (mergeStatusPending(mergeStateStatus)) {
    return 'GitHub is calculating merge readiness'
  }
  return openedTime ? `Opened ${openedTime}` : ''
}

export function mergeReadiness({
  detail,
  checks,
  unresolvedCount,
  approvedReviewCount,
  openedTime,
}: MergeReadinessInput): MergeReadiness {
  const checksCurrent = !checks || checks.headSha === detail.headSha
  const base = detail.baseRef ?? 'main'
  const conflicted = detail.mergeStateStatus === 'dirty' || detail.mergeable === false
  const requiredApprovingReviewCount = detail.requiredApprovingReviewCount ?? null
  const line = note({
    checksCurrent,
    checksState: checks?.state,
    conflicted,
    base,
    unresolvedCount,
    requiredApprovingReviewCount,
    approvedReviewCount,
    mergeStateStatus: detail.mergeStateStatus,
    openedTime,
  })
  const checksFailing = checksNeedAttention(checks, detail.mergeStateStatus)
  const branchBehind = detail.mergeStateStatus === 'behind'
  const blocked = conflicted || checksFailing || branchBehind

  if (detail.state === 'merged') {
    return { key: 'merged', headline: `Merged into ${base}`, note: line, blocked: false }
  }
  if (detail.state === 'closed') {
    return { key: 'closed', headline: 'Closed', note: line, blocked: false }
  }
  if (detail.draft) {
    return { key: 'draft', headline: 'Still a draft', note: line, blocked }
  }

  const ready = [
    !conflicted,
    hostCanMerge(detail),
    !checksFailing,
    checks?.state !== 'pending',
    checksCurrent,
    requiredApprovingReviewCount === null ||
      approvedReviewCount >= requiredApprovingReviewCount,
    unresolvedCount === 0,
  ].every(Boolean)
  if (ready) {
    return { key: 'ready', headline: 'Ready to merge', note: line, blocked: false }
  }
  if (blocked) {
    if (checksFailing) {
      return { key: 'checks', headline: 'Checks need attention', note: line, blocked }
    }
    if (conflicted) {
      return { key: 'conflicts', headline: `Conflicts with ${base}`, note: line, blocked }
    }
    return {
      key: 'behind',
      headline: 'Branch is out of date',
      note: line,
      blocked,
    }
  }
  if (checks?.state === 'pending') {
    return { key: 'open', headline: 'Checks in progress', note: line, blocked: false }
  }
  if (mergeStatusPending(detail.mergeStateStatus)) {
    return { key: 'open', headline: 'Merge status pending', note: line, blocked: false }
  }
  return { key: 'open', headline: 'Review in progress', note: line, blocked }
}

export type MergeReadinessTone = 'positive' | 'negative' | 'review' | 'neutral'

/**
 * The colour the status card's glyph takes. It follows the same host palette
 * the list's status dots use — merged is purple, a blocker is red, ready is
 * green — and everything still in motion stays neutral, so the card is only
 * ever coloured when the colour says something the headline does not.
 */
export function readinessTone(key: MergeReadinessKey): MergeReadinessTone {
  switch (key) {
    case 'ready':
      return 'positive'
    case 'checks':
    case 'conflicts':
    case 'behind':
    case 'closed':
      return 'negative'
    case 'merged':
      return 'review'
    default:
      return 'neutral'
  }
}
