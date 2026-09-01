import { describe, expect, test } from 'bun:test'
import type { PrCommit, PrConversationItem, ReviewThread } from '../../src/shared/providers'
import { buildActivityTimeline } from '../../src/renderer/components/pr-review/lib/activity-data'

describe('PR activity timeline conversation', () => {
  test('interleaves durable issue comments and review bodies with commits and threads', () => {
    const commits: PrCommit[] = [
      { sha: 'a', message: 'First', author: 'author', committedAt: '2026-01-01T10:00:00Z' },
      { sha: 'b', message: 'Second', author: 'author', committedAt: '2026-01-01T13:00:00Z' },
    ]
    const threads: ReviewThread[] = [{
      id: 'thread-1',
      filePath: 'src/example.ts',
      line: 4,
      side: 'RIGHT',
      isResolved: false,
      isOutdated: false,
      comments: [{
        id: 'inline-1',
        author: 'reviewer',
        body: 'Inline feedback',
        createdAt: '2026-01-01T12:00:00Z',
      }],
    }]
    const conversation: PrConversationItem[] = [
      {
        id: 'issue-1',
        kind: 'comment',
        author: 'teammate',
        body: 'LGTM pending CI',
        createdAt: '2026-01-01T11:00:00Z',
      },
      {
        id: 'review-1',
        kind: 'review',
        author: 'reviewer',
        body: 'Please address the inline note.',
        createdAt: '2026-01-01T14:00:00Z',
        reviewState: 'CHANGES_REQUESTED',
      },
    ]

    const timeline = buildActivityTimeline(commits, threads, conversation)

    expect(timeline.map((event) => event.kind)).toEqual([
      'commits',
      'comment',
      'thread',
      'commits',
      'comment',
    ])
    const review = timeline[4]
    expect(review.kind === 'comment' ? review.comment : null).toMatchObject({
      id: 'review-1',
      kind: 'review',
      author: 'reviewer',
      reviewState: 'CHANGES_REQUESTED',
    })
  })
})
