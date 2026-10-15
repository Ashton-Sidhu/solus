import { HostBatches, pullRequestByNumber } from './host-batches'
import { NEEDS_REVIEW_FIELDS, type GqlNeedsReviewPullRequest } from './pull-request-rows'

/** PR sync's read of pull requests by number (docs/plans/pr-sync.md §3.2), in
 *  documents shared by the repositories of one account (host-batches.ts). */
export const pullRequestsByNumber = new HostBatches<GqlNeedsReviewPullRequest>({
  operation: 'PrSyncByNumber',
  perDocument: 25,
  field: pullRequestByNumber(() => '...NeedsReviewFields'),
  fragments: NEEDS_REVIEW_FIELDS,
})
