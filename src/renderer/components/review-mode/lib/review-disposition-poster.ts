import type { DraftReview } from '../../../../shared/providers'
import type { IpcContext, PrReviewContext } from '../../../../shared/types'
import type { PendingDisposition } from '../../../../shared/review-session-types'
import type { DispositionPoster } from './review-session-core'

interface ReviewDispositionPosterOptions {
  getContext: () => IpcContext
  getReview: (prNumber: number) => PrReviewContext | null
  submit: (ctx: IpcContext, prNumber: number, review: DraftReview) => Promise<void>
}

/** Maps held session outcomes onto the same provider submission used by SubmitReviewModal. */
export function createReviewDispositionPoster(
  options: ReviewDispositionPosterOptions,
): DispositionPoster {
  return {
    async post(disposition: PendingDisposition): Promise<void> {
      if (disposition.outcome === 'deferred' || disposition.outcome === 'skipped') return

      const pr = options.getReview(disposition.prNumber)
      if (!pr) throw new Error(`PR #${disposition.prNumber} is not ready to submit`)

      const body = disposition.body?.trim() ?? ''
      if (
        (disposition.outcome === 'changes_requested' || disposition.outcome === 'commented')
        && !body
      ) {
        throw new Error('A review summary is required for this disposition')
      }

      const event: DraftReview['event'] = disposition.outcome === 'approved'
        ? 'APPROVE'
        : disposition.outcome === 'changes_requested'
          ? 'REQUEST_CHANGES'
          : 'COMMENT'
      await options.submit(options.getContext(), disposition.prNumber, {
        body,
        event,
        commitId: pr.headSha,
        baseSha: pr.baseSha,
        comments: [],
      })
    },
  }
}
