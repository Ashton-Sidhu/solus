import { describe, expect, test } from 'bun:test'
import type { PlanComment } from '@solus/contracts/types'
import type { User } from '@solus/contracts/user'
import { deriveWorkReviewState, type WorkReview, type WorkReviewer } from '@solus/contracts/work-review'
import { workReviewNotice } from '@solus/workspace-ui/contexts/works/work-review-notice'
import { isVerdict, openThreadsPrompt, reviewCandidates, reviewerActivity, reviewerStatus } from '@solus/workspace-ui/components/work/lib/work-review'
import { DEFAULT_FILTER, applyFilter, parseToken, rowStatus, type WorkspaceItem } from '@solus/workspace-ui/components/workspace/lib/workspace-items'

/**
 * The client half of work review (docs/plans/work-review-and-live-editing.md,
 * phase 2): who is told what, how a stale decision reads, and how the gallery
 * finds the works waiting on the reader.
 */

const alice: User = { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' }
const bob: User = { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' }

function reviewer(over: Partial<WorkReviewer> = {}): WorkReviewer {
  return {
    reviewerId: 'bob', displayName: 'Bob', colorIndex: 0, requestedBy: alice, requestedAt: '2026-09-30T00:00:00.000Z', requestMessage: null,
    requestedRevisionId: 2, decision: null, decisionSummary: null, decidedAt: null, decidedRevisionId: null, isStale: false, isAwaiting: true, ...over,
  }
}

describe('the verdict badge', () => {
  test('only a current approval or change request marks the reviewer who gave it', () => {
    expect(isVerdict(reviewer({ decision: 'approved' }))).toBe(true)
    expect(isVerdict(reviewer({ decision: 'changes_requested' }))).toBe(true)
    expect(isVerdict(reviewer({ decision: 'approved', isStale: true }))).toBe(false)
    expect(isVerdict(reviewer({ decision: 'commented' }))).toBe(false)
    expect(isVerdict(reviewer())).toBe(false)
  })
})

describe('the review state', () => {
  test('a current request for changes wins, a stale approval does not count', () => {
    expect(deriveWorkReviewState([])).toBe('draft')
    expect(deriveWorkReviewState([{ decision: 'approved', isStale: true }])).toBe('in_review')
    expect(deriveWorkReviewState([{ decision: 'approved', isStale: false }, { decision: null, isStale: false }])).toBe('approved')
    expect(deriveWorkReviewState([{ decision: 'approved', isStale: false }, { decision: 'changes_requested', isStale: false }])).toBe('changes_requested')
  })
})

describe('who hears about a change', () => {
  const review = (decision: WorkReviewer['decision']): WorkReview => ({ workId: 'w', state: 'approved', reviewers: [reviewer({ decision, isAwaiting: false })] })

  test('a request is news to the people asked, and to nobody else', () => {
    const change = { workId: 'w', change: 'requested' as const, reviewerIds: ['bob'], by: alice }
    expect(workReviewNotice(change, null, bob.id, 'Spec')).toBe('Alice asked you to review “Spec”')
    expect(workReviewNotice(change, null, { kind: 'account', accountId: 'carol' }, 'Spec')).toBeNull()
  })

  test('a decision is news to the person who asked for it', () => {
    const change = { workId: 'w', change: 'decided' as const, reviewerIds: ['bob'], by: bob }
    expect(workReviewNotice(change, review('changes_requested'), alice.id, 'Spec')).toBe('Bob requested changes on “Spec”')
    expect(workReviewNotice(change, review('approved'), { kind: 'account', accountId: 'carol' }, 'Spec')).toBeNull()
  })

  test("the reader's own action is never news", () => {
    const change = { workId: 'w', change: 'decided' as const, reviewerIds: ['bob'], by: bob }
    expect(workReviewNotice(change, review('approved'), bob.id, 'Spec')).toBeNull()
  })
})

describe('reviewer rows', () => {
  test('a stale decision says it is about an earlier version', () => {
    expect(reviewerStatus(reviewer())).toBe('Waiting for review')
    expect(reviewerStatus(reviewer({ decision: 'approved', isAwaiting: false }))).toBe('Approved')
    expect(reviewerStatus(reviewer({ decision: 'approved', isStale: true, isAwaiting: false }))).toBe('Approved an earlier version')
    expect(reviewerStatus(reviewer({ decision: 'changes_requested', isStale: true, isAwaiting: true }))).toBe('Requested changes on an earlier version · review requested again')
  })

  test('the hover text says what the icon shows, and when it happened', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    expect(reviewerActivity(reviewer({ decision: 'approved', isAwaiting: false, decidedAt: twoHoursAgo }))).toBe('Approved · 2h ago')
    expect(reviewerActivity(reviewer({ requestedAt: twoHoursAgo }))).toBe('Waiting for review · 2h ago')
    expect(reviewerActivity(reviewer({ requestedAt: null }))).toBe('Waiting for review')
  })

  test('the picker offers members who are not the reader and not already waiting', () => {
    const carol: User = { id: { kind: 'account', accountId: 'carol' }, displayName: 'Carol' }
    const people = { organizationId: 'A', name: 'Acme', members: [alice, bob, carol], teams: [] }
    const review: WorkReview = { workId: 'w', state: 'in_review', reviewers: [reviewer()] }
    expect(reviewCandidates(people, review, 'alice', '').map((member) => member.displayName)).toEqual(['Carol'])
    expect(reviewCandidates(people, null, 'alice', 'bo').map((member) => member.displayName)).toEqual(['Bob'])
  })

  test('the agent is asked to answer and resolve each open thread, and resolved threads are left out', () => {
    const comment = (id: string, resolvedAt?: number): PlanComment => ({ id, selectedText: 'intro', comment: 'Tighten', createdAt: 1, ...(resolvedAt ? { resolvedAt } : {}) }) as PlanComment
    const prompt = openThreadsPrompt('Spec', 'w1', [comment('c1'), comment('c2', 5)])!
    expect(prompt).toContain('reply_comment')
    expect(prompt).toContain('- c1: "intro"')
    expect(prompt).not.toContain('c2')
    expect(openThreadsPrompt('Spec', 'w1', [comment('c2', 5)])).toBeNull()
  })
})

describe('the gallery', () => {
  const item = (over: Partial<WorkspaceItem>): WorkspaceItem => ({
    id: 'w', rowKey: 'work:w', type: 'doc', glyph: 'doc', title: 'Spec', snippet: '', timestamp: Date.now(), createdAt: 0, sessionId: null,
    pinned: false, pinnedAt: 0, cwd: '/repo', projectKey: '/repo', projectLabel: 'repo', reviewState: null, reviewers: [], awaitingMyReview: false,
    work: {} as never, ...over,
  })

  test('"Needs my review" keeps only the works waiting on the reader', () => {
    const items = [item({ id: 'mine', awaitingMyReview: true, reviewState: 'in_review' }), item({ id: 'other', reviewState: 'approved' })]
    expect(applyFilter(items, { ...DEFAULT_FILTER, awaitingMyReview: true }).map((i) => i.id)).toEqual(['mine'])
    expect(parseToken('is:review-requested')).toEqual({ awaitingMyReview: true })
  })

  test('a row says the work waits on the reader before it says its state', () => {
    expect(rowStatus(item({ awaitingMyReview: true, reviewState: 'approved' }))?.kind).toBe('review_requested')
    expect(rowStatus(item({ reviewState: 'changes_requested' }))?.kind).toBe('changes_requested')
    expect(rowStatus(item({}))).toBeNull()
  })
})
