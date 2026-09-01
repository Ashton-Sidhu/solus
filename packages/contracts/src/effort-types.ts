import type { ChangedFileStat } from './git-types'

/** Pacing only, never gating: a band changes queue ORDER and the time estimate,
 *  never what is shown. A `quick` PR still opens its full diff (design principle 1). */
export type EffortBand = 'quick' | 'standard' | 'involved'

export interface ReviewEffort {
  minutes: number
  band: EffortBand
  /** Why this band — "lockfile only", "12 files · 340 lines", "touches auth/".
   *  Rendered in the chip's tooltip, and the assertion surface for WS4's unit
   *  tests: a band alone cannot encode intent, so tests assert on signals
   *  (CLAUDE.md rule 6 — a test must encode *why* the behaviour matters). */
  signals: string[]
}

export interface EffortInput {
  /** Carries `path` already — the doc's separate `filePaths` param is dropped as
   *  a second source of truth for the same list. */
  fileStats: ChangedFileStat[]
  /** Rename-only churn: path movement with nothing to read. */
  renamedPaths: string[]
  /** Resolved by the caller from linguist patterns + `.gitattributes`
   *  `linguist-generated`; the estimator stays pure and does no IO. */
  generatedPaths: string[]
}

/** Pure, synchronous, no model call, no IO (design principle 2). */
export declare function estimateReviewEffort(input: EffortInput): ReviewEffort
