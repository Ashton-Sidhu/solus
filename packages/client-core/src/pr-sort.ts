import type { PullRequest } from '@solus/contracts/providers'
import type { PrSort } from '@solus/contracts/pr-views'
import type { PrChecksState } from '@solus/contracts/checks-types'

export interface PrSortFacts {
  viewerLogin: string | null
  checks: PrChecksState | null
}
function hasConflict(pr: PullRequest): boolean {
  return pr.state === 'open' && (pr.mergeable === false || pr.mergeStateStatus === 'dirty')
}
function blockedOnViewer(pr: PullRequest, facts: PrSortFacts): boolean {
  if (pr.state !== 'open' || !facts.viewerLogin) return false
  const login = facts.viewerLogin.toLowerCase()
  if (
    pr.needsMyReview ||
    pr.requestedReviewers?.some((reviewer) => reviewer.login.toLowerCase() === login)
  )
    return true
  return (
    pr.author.toLowerCase() === login &&
    (facts.checks === 'failing' || hasConflict(pr) || pr.reviewStatus === 'changes-requested')
  )
}
function readiness(pr: PullRequest, checks: PrChecksState | null): number {
  if (hasConflict(pr)) return 4
  if (pr.state !== 'open') return 3
  if (pr.draft) return 2
  if (checks === 'passing') return pr.reviewStatus === 'approved' ? 0 : 1
  return 2
}
/** Both native and workspace queues use the same ordering; ties are stable by URL. */
export function comparePrs(
  a: PullRequest,
  b: PullRequest,
  sort: PrSort,
  facts: (pr: PullRequest) => PrSortFacts
): number {
  const updated = b.updatedAt.localeCompare(a.updatedAt) || a.url.localeCompare(b.url)
  const sizeA = a.additions + a.deletions,
    sizeB = b.additions + b.deletions
  switch (sort) {
    case 'ready':
      return (
        readiness(a, facts(a).checks) - readiness(b, facts(b).checks) ||
        Number(sizeA === 0) - Number(sizeB === 0) ||
        sizeA - sizeB ||
        updated
      )
    case 'blocked':
      return Number(blockedOnViewer(b, facts(b))) - Number(blockedOnViewer(a, facts(a))) || updated
    case 'created':
      return b.createdAt.localeCompare(a.createdAt) || updated
    case 'oldest':
      return a.updatedAt.localeCompare(b.updatedAt) || a.url.localeCompare(b.url)
    case 'smallest':
      return Number(sizeA === 0) - Number(sizeB === 0) || sizeA - sizeB || updated
    case 'largest':
      return sizeB - sizeA || updated
    default:
      return updated
  }
}
