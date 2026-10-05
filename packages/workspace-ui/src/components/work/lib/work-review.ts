import type { PlanComment } from '@solus/contracts/types'
import { userKey, type User } from '@solus/contracts/user'
import type { WorkReview, WorkReviewer, WorkReviewState } from '@solus/contracts/work-review'
import type { OrganizationPeople } from '../../users/lib/organization-people'
import { formatInlineComments } from '../../../contexts/workspace/session.utils'
import { relativeTime } from '../../../lib/relative-time'

export function reviewStateLabel(state: WorkReviewState): string {
  switch (state) {
    case 'draft': return 'Draft'
    case 'in_review': return 'In review'
    case 'changes_requested': return 'Changes requested'
    case 'approved': return 'Approved'
  }
}

/**
 * What a reviewer's row says. A stale decision stays visible, and says it is
 * about an earlier version, so no one reads it as a verdict on the current body.
 */
export function reviewerStatus(reviewer: Pick<WorkReviewer, 'decision' | 'isStale' | 'isAwaiting'>): string {
  if (!reviewer.decision) return 'Waiting for review'
  const earlier = reviewer.isStale ? ' an earlier version' : ''
  const status = reviewer.decision === 'approved'
    ? `Approved${earlier}`
    : reviewer.decision === 'changes_requested'
      ? reviewer.isStale ? 'Requested changes on an earlier version' : 'Changes requested'
      : reviewer.isStale ? 'Commented on an earlier version' : 'Commented'
  return reviewer.isAwaiting ? `${status} · review requested again` : status
}

/** What a reviewer did and when, for the hover text that stands in for the words the icons replace. */
export function reviewerActivity(reviewer: Pick<WorkReviewer, 'decision' | 'isStale' | 'isAwaiting' | 'decidedAt' | 'requestedAt'>): string {
  const at = reviewer.decision ? reviewer.decidedAt : reviewer.requestedAt
  return at ? `${reviewerStatus(reviewer)} · ${relativeTime(Date.parse(at))}` : reviewerStatus(reviewer)
}

/** The reviewer's name as the organization lists them now, else as the host stamped it. */
export function reviewerName(reviewer: Pick<WorkReviewer, 'reviewerId' | 'displayName'>, people: OrganizationPeople | null): string {
  return people?.members.find((member) => userKey(member.id) === reviewer.reviewerId)?.displayName ?? reviewer.displayName
}

/** Members the reader can still ask: not themselves, and not already waiting on a request. */
export function reviewCandidates(people: OrganizationPeople | null, review: WorkReview | null, selfKey: string | null, query: string): User[] {
  const waiting = new Set((review?.reviewers ?? []).filter((reviewer) => reviewer.isAwaiting).map((reviewer) => reviewer.reviewerId))
  const needle = query.trim().toLowerCase()
  return (people?.members ?? []).filter((member) => {
    const key = userKey(member.id)
    if (key === selfKey || waiting.has(key)) return false
    return !needle || member.displayName.toLowerCase().includes(needle) || (member.email?.toLowerCase().includes(needle) ?? false)
  })
}

/** The reader's own row, when they review this work. */
export function ownReviewer(review: WorkReview | null, selfKey: string | null): WorkReviewer | null {
  if (!review || !selfKey) return null
  return review.reviewers.find((reviewer) => reviewer.reviewerId === selfKey) ?? null
}

/**
 * The prompt that hands the open threads to the work's agent. It names each
 * thread's id so the agent answers in the thread (`reply_comment`) and
 * resolves it (`resolve_comment`) once the work addresses it; the threads stay
 * open until then, so the reviewers see what was done.
 */
export function openThreadsPrompt(title: string, workId: string, comments: readonly PlanComment[]): string | null {
  const open = comments.filter((comment) => !comment.resolvedAt)
  if (open.length === 0) return null
  const ids = open.map((comment) => `- ${comment.id}: "${comment.selectedText}"`).join('\n')
  return [
    `Please address the open review comments on "${title}" (work_id: ${workId}).`,
    `Read the work with read_work, change it with update_work, then answer each thread with reply_comment and resolve it with resolve_comment (target_id: ${workId}) when the change addresses it.`,
    '',
    formatInlineComments([...open]),
    '',
    `Thread ids:\n${ids}`,
  ].join('\n')
}
