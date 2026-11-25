import type { PullRequest } from '@solus/contracts/providers'

export function readsPendingWorkflowRuns(detail: PullRequest): boolean {
  return detail.state === 'open' && detail.capabilities.actions.includes('approve-workflows')
}
