import type { PullRequest } from './providers'
import type { Task, TaskProviderId } from './task-types'

/** Provider-native relevance filter for the live band in the task inbox. */
export type InboxInvolvement =
  | 'assigned'
  | 'review_requested'
  | 'mentioned'
  | 'authored'
  | 'all'

export interface InboxScopeProject {
  projectKey: string
  projectLabel: string
}

export interface InboxPullRequest extends PullRequest {
  provider: 'github'
  externalKey: string
}

/** One distinct bound provider scope. Projects which share the binding point
 * at this same result, so a client can choose the correct import home. */
export interface InboxUpstreamScope {
  provider: Exclude<TaskProviderId, 'local'>
  externalKey: string
  projects: InboxScopeProject[]
  tickets: Task[]
  pullRequests: InboxPullRequest[]
  fetchedAt?: number
  fromCache?: boolean
  truncated?: boolean
  ticketError?: string
  pullRequestError?: string
}

export interface InboxUpstreamResult {
  scopes: InboxUpstreamScope[]
}
