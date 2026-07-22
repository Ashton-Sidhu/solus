import type { PrInterdiffResult, ReviewThreadHunkMatch } from '../../../../shared/types'
import type { ReviewThread } from '../../../../shared/providers'

export function matchedReviewComments(result: PrInterdiffResult): ReviewThreadHunkMatch[] {
  return result.commentMatches.filter((match) => match.hunk !== null)
}

export function unmatchedReviewComments(result: PrInterdiffResult): ReviewThreadHunkMatch[] {
  return result.commentMatches.filter((match) => match.hunk === null)
}

export function reviewCommentPreview(thread: ReviewThread, maxLength = 96): string {
  const body = thread.comments[0]?.body.replace(/\s+/g, ' ').trim() ?? 'Review comment'
  return body.length > maxLength ? `${body.slice(0, maxLength - 1)}…` : body
}

export function reviewedAtLabel(reviewedAt: string): string {
  const date = new Date(reviewedAt)
  if (!Number.isFinite(date.getTime())) return 'your last review'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}
