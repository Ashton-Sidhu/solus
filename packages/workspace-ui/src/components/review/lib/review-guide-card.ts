import type { ReviewGuideStatusEvent } from '@solus/contracts/review'

export interface ReviewGuideCardPresentation {
  statusLabel: string
  subtitle: string
  canRetry: boolean
}

export function reviewGuideCardPresentation(
  status: ReviewGuideStatusEvent | null,
): ReviewGuideCardPresentation {
  if (!status) {
    return {
      statusLabel: 'Preparing',
      subtitle: 'Checking guide status',
      canRetry: true,
    }
  }

  switch (status.status) {
    case 'queued':
      return {
        statusLabel: 'Preparing',
        subtitle: 'Queued for review',
        canRetry: false,
      }
    case 'generating':
      return {
        statusLabel: status.step === 'analyzing'
          ? 'Analyzing'
          : status.step === 'writing'
            ? 'Writing'
            : 'Preparing',
        subtitle: status.step === 'writing'
          ? 'Writing the guided walkthrough'
          : status.step === 'analyzing'
            ? 'Analyzing session changes'
            : 'Preparing the review',
        canRetry: false,
      }
    case 'ready':
      return {
        statusLabel: 'Ready',
        subtitle: 'Open the guided walkthrough',
        canRetry: false,
      }
    case 'outdated':
      return {
        statusLabel: 'Outdated',
        subtitle: 'The reviewed changes moved while the guide was running',
        canRetry: true,
      }
    case 'failed':
      return {
        statusLabel: 'Failed',
        subtitle: status.error ?? 'The guide could not be completed',
        canRetry: true,
      }
    case 'cancelled':
      return {
        statusLabel: 'Cancelled',
        subtitle: 'Guide generation was cancelled',
        canRetry: true,
      }
  }
}
