import { describe, expect, test } from 'bun:test'
import type { PrConversationItem, ReviewThread } from '@solus/contracts/providers'
import { groupThreadsByReview, reviewIsEvent } from '@solus/client-core/review-groups'
import { buildActivityTimeline, filterActivityTimeline } from '@solus/workspace-ui/components/pr-review/lib/activity-data'

// The host shows a review once, with the inline threads it was submitted with
// nested under it. A timeline that lists the review and each of its threads as
// unrelated cards reads as six events for one act of review.

function thread(id: string, reviewId: string | undefined, createdAt: string, isResolved = false): ReviewThread {
  const first: ReviewThread['comments'][number] = { id: `${id}-1`, author: 'reviewer', body: 'Look here', createdAt }
  if (reviewId) first.reviewId = reviewId
  return { id, filePath: 'src/a.ts', line: 3, side: 'RIGHT', isResolved, isOutdated: false, comments: [first] }
}

const review = (id: string, createdAt: string, state: 'APPROVED' | 'COMMENTED' | 'CHANGES_REQUESTED', body = ''): PrConversationItem =>
  ({ id, kind: 'review', author: 'reviewer', body, createdAt, reviewState: state })

describe('review thread groups', () => {
  test('a thread hangs from the review of its first comment; others stand alone', () => {
    const conversation = [review('R1', '2026-01-01T12:00:00Z', 'CHANGES_REQUESTED', 'Please fix')]
    const inReview = thread('t1', 'R1', '2026-01-01T11:59:00Z')
    const lone = thread('t2', undefined, '2026-01-02T00:00:00Z')
    const orphan = thread('t3', 'R-not-listed', '2026-01-02T00:00:00Z')
    const groups = groupThreadsByReview(conversation, [inReview, lone, orphan])
    expect(groups.byReview.get('R1')).toEqual([inReview])
    expect(groups.standalone).toEqual([lone, orphan])
  })

  test('a verdict is always an event; a comment-only review needs a body or a thread', () => {
    expect(reviewIsEvent(review('R', '', 'APPROVED'), [])).toBe(true)
    expect(reviewIsEvent(review('R', '', 'COMMENTED'), [])).toBe(false)
    expect(reviewIsEvent(review('R', '', 'COMMENTED', '<!-- bot marker -->'), [])).toBe(false)
    expect(reviewIsEvent(review('R', '', 'COMMENTED', 'A note'), [])).toBe(true)
    expect(reviewIsEvent(review('R', '', 'COMMENTED'), [thread('t', 'R', '')])).toBe(true)
  })
})

describe('activity timeline review nesting', () => {
  const conversation = [
    review('R1', '2026-01-01T12:00:00Z', 'CHANGES_REQUESTED', 'Two things'),
    review('R2', '2026-01-03T12:00:00Z', 'COMMENTED'),
    review('R3', '2026-01-04T12:00:00Z', 'APPROVED'),
  ]
  const threads = [
    thread('t-late', 'R1', '2026-01-01T11:58:00Z'),
    thread('t-early', 'R1', '2026-01-01T11:50:00Z', true),
    thread('t-lone', undefined, '2026-01-02T00:00:00Z'),
  ]
  const timeline = buildActivityTimeline([], threads, conversation)

  test('the review carries its threads in time order at the review time, and lone threads keep their own', () => {
    expect(timeline.map((e) => (e.kind === 'comment' ? `${e.kind}:${e.comment.id}` : e.kind === 'thread' ? `thread:${e.thread.id}` : e.kind)))
      .toEqual(['comment:R1', 'thread:t-lone', 'comment:R3'])
    const r1 = timeline[0]
    expect(r1.kind === 'comment' && r1.threads.map((t) => t.id)).toEqual(['t-early', 't-late'])
  })

  test('a bodiless comment-only review with no threads is not an event, an approval is', () => {
    expect(timeline.some((e) => e.kind === 'comment' && e.comment.id === 'R2')).toBe(false)
    expect(timeline.some((e) => e.kind === 'comment' && e.comment.id === 'R3')).toBe(true)
  })

  test('the unresolved filter surfaces nested open threads on their own', () => {
    const unresolved = filterActivityTimeline(timeline, 'all', true)
    expect(unresolved.map((e) => e.kind === 'thread' && e.thread.id)).toEqual(['t-late', 't-lone'])
  })
})
