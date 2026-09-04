import { describe, expect, test } from 'bun:test'
import type { PrCommit, PrConversationItem, ReviewThread } from '@solus/contracts/providers'
import {
  buildActivityTimeline,
  filterActivityTimeline,
  prLabelActivityText,
  visibleConversationCount,
} from '@solus/workspace-ui/components/pr-review/lib/activity-data'

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

describe('PR label activity', () => {
  const added = {
    id: 'label-1',
    kind: 'label',
    author: 'sidhu',
    createdAt: '2026-01-01T11:00:00Z',
    action: 'added',
    label: { name: 'bug', color: 'd73a4a' },
  } satisfies PrConversationItem

  test('names the label and uses You for the connected viewer', () => {
    // WHY: PR activity is an audit trail too. The exact label must survive the
    // provider boundary instead of collapsing to "changed the labels".
    expect(prLabelActivityText(added, 'sidhu')).toBe('You added label “bug”')
    expect(prLabelActivityText({ ...added, action: 'removed' }, 'someone-else'))
      .toBe('sidhu removed label “bug”')
  })

  test('interleaves label events but does not call them conversation', () => {
    const timeline = buildActivityTimeline([], [], [added])
    expect(timeline.map((event) => event.kind)).toEqual(['label'])
    expect(filterActivityTimeline(timeline, 'conversation', false)).toEqual([])
  })

  test('does not count label events as feedback with a body', () => {
    // WHY: Label events share the provider activity list with comments but do
    // not have a body. Reading one as feedback must not crash the PR surface.
    expect(visibleConversationCount([
      added,
      {
        id: 'comment-1',
        kind: 'comment',
        author: 'reviewer',
        body: 'Please update this.',
        createdAt: '2026-01-01T12:00:00Z',
      },
    ])).toBe(1)
  })
})
