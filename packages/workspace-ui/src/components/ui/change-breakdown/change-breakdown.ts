import type { ChangeBreakdownPart } from '@solus/client-core/change-breakdown'

/** Each kind's churn as a percentage of the largest kind's, so the largest
 *  bar fills its track and the others read against it. */
export function churnShares(parts: readonly ChangeBreakdownPart[]): number[] {
  const churn = parts.map((part) => part.additions + part.deletions)
  const largest = Math.max(1, ...churn)
  return churn.map((value) => Math.max(4, Math.round((value / largest) * 100)))
}
