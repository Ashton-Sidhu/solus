import type { ReviewThreadHunkMatch } from '@solus/contracts/types'
import type { ReviewThread } from '@solus/contracts/providers'

export interface DiffReviewThread extends ReviewThread {
  reviewContext?: 'interdiff-match'
}

export function interdiffAnnotationAnchor(match: ReviewThreadHunkMatch): {
  lineNumber: number
  side: 'additions' | 'deletions'
} | null {
  const hunk = match.hunk
  if (!hunk) return null
  if (hunk.newLines > 0) return { lineNumber: hunk.newStart, side: 'additions' }
  if (hunk.oldLines > 0) return { lineNumber: hunk.oldStart, side: 'deletions' }
  return null
}

export function interdiffReviewThreads(matches: ReviewThreadHunkMatch[]): DiffReviewThread[] {
  return matches.flatMap((match) => {
    const anchor = interdiffAnnotationAnchor(match)
    if (!anchor) return []
    return [{
      ...match.thread,
      line: anchor.lineNumber,
      side: anchor.side === 'additions' ? 'RIGHT' : 'LEFT',
      reviewContext: 'interdiff-match' as const,
    }]
  })
}
