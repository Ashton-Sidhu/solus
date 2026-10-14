import type { PullRequest } from '@solus/contracts/providers'
import { prActionAllowed } from './merge-readiness'

/**
 * GitHub holds the Actions runs of a fork pull request until a maintainer
 * approves them. The host reads them only for an open pull request from a
 * fork, and only a host that offers the approval can read them at all.
 */
export function readsPendingWorkflowRuns(detail: PullRequest): boolean {
  return detail.state === 'open' && detail.headRepo.isFork && detail.capabilities.actions.includes('approve-workflows')
}

export function mayApproveWorkflowRuns(detail: PullRequest): boolean {
  return readsPendingWorkflowRuns(detail) && prActionAllowed(detail, 'approve-workflows')
}

/** "2 workflows are waiting for approval". */
export function pendingWorkflowsHeadline(count: number): string {
  return count === 1 ? '1 workflow is waiting for approval' : `${count} workflows are waiting for approval`
}
