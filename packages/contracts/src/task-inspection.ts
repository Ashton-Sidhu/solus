import type { TaskAssigneeCandidate, TaskDetails } from './task-types'

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
}
export interface TaskProviderPullRequest {
  url: string
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'unknown'
  closesIssue: boolean
}
export interface TaskInspection {
  author: string | null
  assignees: TaskAssigneeCandidate[]
  commentsTruncated?: boolean
  reactions: TaskReaction[]
  events: TaskProviderEvent[]
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
  inspection: TaskInspection
  readOnly: boolean
}
export type TaskInvolvement = 'all' | 'authored' | 'assigned' | 'mentioned'
