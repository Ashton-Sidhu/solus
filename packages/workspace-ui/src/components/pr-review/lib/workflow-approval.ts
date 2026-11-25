import type { PullRequest } from '@solus/contracts/providers'
import { prActionAllowed } from './merge-readiness'

export function readsPendingWorkflowRuns(detail: PullRequest): boolean {
  return detail.state === 'open' && detail.capabilities.actions.includes('approve-workflows')
}

export function mayApproveWorkflowRuns(detail: PullRequest): boolean {
  return readsPendingWorkflowRuns(detail) && prActionAllowed(detail, 'approve-workflows')
}

/** "2 workflows are waiting for approval". */
export function pendingWorkflowsHeadline(count: number): string {
  return count === 1 ? '1 workflow is waiting for approval' : `${count} workflows are waiting for approval`
}
