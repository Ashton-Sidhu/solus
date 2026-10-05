import type { ReviewGuideStatus, ReviewTarget } from '@solus/contracts/review'
import { ulid } from '@solus/contracts/ulid'
import type { Attribution } from '@solus/contracts/user'
import { getDatabase } from '../db/database'
import { recordNotification } from '../data/notifications/store'
import { createLogger } from '../logger'

const log = createLogger('notifications', 'review-job-results.ts')

/** The person who asked for a generation, and the organization their hub reads it in. */
export interface ReviewJobRequester {
  recipientKey: string
  organizationId: string
  by: Attribution
}

export interface ReviewJobRun {
  job: 'guide' | 'lens'
  target: Extract<ReviewTarget, { kind: 'pr' }>
  lensId?: string
  title: string
}

/**
 * Tell the person who asked for a guide or a lens that it finished
 * (plans/015-notifications-hub.md §5). Answers a status listener for one request:
 * the first `ready` or `failed` of the run records one row; a cancellation or a
 * newer revision records none. The result stays on this host; the row names it.
 */
export function notifyOnReviewJobResult<T extends { status: ReviewGuideStatus; error?: string }>(
  requester: ReviewJobRequester | null,
  run: ReviewJobRun,
  forward: (event: T) => void,
): (event: T) => Promise<void> | void {
  if (!requester) return forward
  const runId = ulid()
  let isRecorded = false
  // Answers the write, so a caller that must know it committed can wait; a status listener ignores it.
  return (event) => {
    forward(event)
    if (isRecorded || (event.status !== 'ready' && event.status !== 'failed')) return
    isRecorded = true
    const { host, owner, repo, number, url } = run.target
    const pr = url ? { host, owner, repo, number, url } : { host, owner, repo, number }
    const recorded = getDatabase().transaction(async (tx) => {
      await recordNotification(tx, {
        organizationId: requester.organizationId,
        eventId: `review_job.finished:${run.job}:${runId}`,
        recipients: [requester.recipientKey],
        facts: event.status === 'ready'
          ? { kind: 'review_job.finished', status: 'ready' }
          : { kind: 'review_job.finished', status: 'failed', error: event.error?.slice(0, 500) },
        resource: run.lensId ? { kind: 'review_job', job: run.job, pr, lensId: run.lensId } : { kind: 'review_job', job: run.job, pr },
        by: requester.by,
        summary: { title: run.title.slice(0, 300) },
      })
    })
    return recorded.catch((error) => log.warn('review_job_notification_failed', { job: run.job, error: error instanceof Error ? error.message : String(error) }))
  }
}
