/**
 * The rows checked for review. Checked rows narrow the Review action: with any
 * checked, Review Mode opens over just those instead of every row. Keyed by the
 * row's qualified key, not a bare number — across every project two
 * repositories can hold the same pull request number.
 */
import type { PullRequest } from '@solus/contracts/providers'
import { SvelteSet } from 'svelte/reactivity'

export interface PrReviewSelectionSource {
  /** Every row the list holds, in list order. */
  rows: () => PullRequest[]
  keyOf: (pr: PullRequest) => string
  /** The project a row belongs to; one value for a single-project list. */
  projectOf: (pr: PullRequest) => string
}

export class PrReviewSelection {
  readonly keys = new SvelteSet<string>()

  constructor(private readonly source: PrReviewSelectionSource) {}

  /** Checked rows in list order. A check on a row no longer listed drops out. */
  readonly selected = $derived.by(() => this.source.rows().filter((pr) => this.keys.has(this.source.keyOf(pr))))
  /** Batch Review and Guides act through one project's host, so a batch that
   *  spans projects is refused rather than silently sent to one of them. */
  readonly spansProjects = $derived.by(() => new Set(this.selected.map((pr) => this.source.projectOf(pr))).size > 1)
  /** Guides are only generated for open, ready pull requests. */
  readonly guideEligible = $derived.by(() => this.selected.filter((pr) => pr.state === 'open' && !pr.draft))

  toggle(pr: PullRequest): void {
    const key = this.source.keyOf(pr)
    if (this.keys.has(key)) this.keys.delete(key)
    else this.keys.add(key)
  }

  clear(): void {
    this.keys.clear()
  }
}
