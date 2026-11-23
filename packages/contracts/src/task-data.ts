import type { TaskAssigneeCandidate, TaskComment, TaskDetails } from './task-types'

export type TaskReactionContent =
  'THUMBS_UP' | 'THUMBS_DOWN' | 'LAUGH' | 'HOORAY' | 'CONFUSED' | 'HEART' | 'ROCKET' | 'EYES'
export interface TaskReaction {
  targetId: string
  content: TaskReactionContent
  count: number
  viewerHasReacted: boolean
}
export interface TaskProviderEvent {
  id: string
  at: number
  actor: string | null
  text: string
  link?: { url: string; label: string }
}
export interface TaskProviderPullRequest {
  url: string
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'unknown'
  closesIssue: boolean
}
export interface TaskProviderData {
  author: string | null
  assignees: TaskAssigneeCandidate[]
  commentsTruncated?: boolean
  reactions: TaskReaction[]
  events: TaskProviderEvent[]
  comments?: TaskComment[]
  historyCursor: string | null
  pullRequests: TaskProviderPullRequest[]
  /** Capabilities are provider support, not permission to write. */
  capabilities: {
    history: boolean
    reactions: boolean
    multipleAssignees: boolean
    templates: boolean
  }
  unavailableReason?: string
}
export type TaskProviderMetadata = Pick<
  TaskProviderData, 'author' | 'assignees' | 'commentsTruncated' | 'reactions' | 'pullRequests'
>

export function withTaskProviderMetadata(
  timeline: TaskProviderData, metadata: TaskProviderMetadata
): TaskProviderData {
  const pullRequests = new Map([...timeline.pullRequests, ...metadata.pullRequests].map((pr) => [pr.url, pr]))
  return { ...timeline, ...metadata, pullRequests: [...pullRequests.values()] }
}
export interface TaskTemplate {
  id: string
  name: string
  description: string
  title: string
  body: string
  labels?: string[]
  assignees?: string[]
  /** Native forms must be completed on their provider. */
  url?: string
}
export interface TaskExternalIssue {
  details: TaskDetails
  inspection?: TaskProviderData
  readOnly: boolean
}
export type TaskInvolvement = 'all' | 'authored' | 'assigned' | 'mentioned'
