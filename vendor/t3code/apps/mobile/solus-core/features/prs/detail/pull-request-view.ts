import type { PullRequest } from '@solus/contracts/providers'
import type { PullRequestPermissions } from '../lib/pull-request-permissions'
import type { PullRequestDetail, PullRequestRef } from '../pull-request-directory'

/** What every part of the pull request detail reads: the pull request as the
 *  device holds it, and what the person may do to it now. */
export interface PullRequestView {
  readonly ref: PullRequestRef
  readonly detail: PullRequestDetail
  readonly pr: PullRequest
  readonly permissions: PullRequestPermissions
  readonly viewerLogin: string | null
}

/** Why the write controls are off when the host is not connected. */
export const OFFLINE_REASON = 'Connect to this host to make changes.'
