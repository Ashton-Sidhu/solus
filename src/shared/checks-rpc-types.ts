import type { PrChecksSummary } from './checks-types'
import type { RepoRef } from './providers'

export interface NumberedPrChecksSummary {
  number: number
  summary: PrChecksSummary
}

/** Full replacement snapshot for one repository. Keeping load failure beside
 *  the summaries prevents a transient provider outage from becoming a fake CI
 *  state. */
export interface PrChecksSnapshot {
  repo: RepoRef
  checks: NumberedPrChecksSummary[]
  loadFailed: boolean
}
