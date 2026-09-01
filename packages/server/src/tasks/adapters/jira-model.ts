import { z } from 'zod'
import type {
  NormalizedTaskComment,
  TaskPriority,
  TaskStatus,
} from '@solus/contracts/task-types'
import { TASKS_AUTH_ERROR_PREFIX } from '@solus/contracts/task-types'
import { adfBodySchema, adfToMarkdown, markdownToAdf } from '../../atlassian/adf'
import type { AtlassianFailure } from '../../atlassian/api'

interface JiraScope {
  cloudId: string
  projectKey: string
}

/** Parse the durable `<cloudId>/<projectKey>` provider scope. */
export function scopeFor(externalKey: string): JiraScope {
  const [cloudId, projectKey, ...extra] = externalKey.split('/')
  if (!cloudId || !projectKey || extra.length) {
    throw new Error(`Invalid Jira task scope: ${externalKey}`)
  }
  return { cloudId, projectKey }
}

type JiraStatusCategory = 'new' | 'indeterminate' | 'done'

export function categoryFor(status: TaskStatus): JiraStatusCategory {
  if (status === 'done' || status === 'dropped') return 'done'
  if (status === 'in_progress' || status === 'in_review') return 'indeterminate'
  return 'new'
}

export function statusFromJira(category: string, name: string): TaskStatus {
  if (category === 'done') return 'done'
  if (category === 'indeterminate') return /review|qa|verif/i.test(name) ? 'in_review' : 'in_progress'
  return 'todo'
}

export const PRIORITY_TO_JIRA = {
  urgent: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
} satisfies Record<TaskPriority, string>

export function priorityFromJira(name: string | undefined): TaskPriority | undefined {
  if (!name) return undefined
  if (/highest|blocker/i.test(name)) return 'urgent'
  if (/high|critical/i.test(name)) return 'high'
  if (/medium|major|normal/i.test(name)) return 'medium'
  if (/low|lowest|minor|trivial/i.test(name)) return 'low'
  return undefined
}

export const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().nullish(),
    description: adfBodySchema,
    updated: z.string(),
    labels: z.array(z.string()).nullish(),
    status: z.object({
      name: z.string(),
      statusCategory: z.object({ key: z.string() }),
    }),
    priority: z.object({ name: z.string() }).nullish(),
    comment: z.object({
      comments: z.array(z.object({
        id: z.string(),
        author: z.object({ displayName: z.string().nullish() }).nullish(),
        body: adfBodySchema,
        created: z.string(),
      })),
    }).nullish(),
  }),
})

export type JiraIssue = z.infer<typeof issueSchema>

export const searchSchema = z.object({ issues: z.array(issueSchema) })
export const pagedSearchSchema = searchSchema.extend({
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
})
export const changedSearchSchema = z.object({
  issues: z.array(z.object({ key: z.string() })),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
})
export const transitionsSchema = z.object({
  transitions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    to: z.object({
      name: z.string(),
      statusCategory: z.object({ key: z.string() }),
    }),
  })),
})
export const createdIssueSchema = z.object({ key: z.string() })
export const issueTypesSchema = z.object({
  issueTypes: z.array(z.object({ id: z.string(), name: z.string(), subtask: z.boolean().nullish() })),
})
export const commentSchema = z.object({
  id: z.string(),
  author: z.object({ displayName: z.string().nullish() }).nullish(),
  body: adfBodySchema,
  created: z.string(),
})

/** Convert transport failures to the sync engine's durable failure classes. */
export function taskSyncFailure(failure: AtlassianFailure): Error {
  const authProblem = failure.status === 401 || failure.status === 403
  return new Error(`${authProblem ? TASKS_AUTH_ERROR_PREFIX : ''}${failure.detail}`)
}

export const ISSUE_FIELDS = 'summary,description,status,labels,priority,updated,comment'
export const LIST_FIELDS = ['summary', 'description', 'status', 'labels', 'priority', 'updated']

export interface JiraFieldUpdate {
  summary?: string
  description?: ReturnType<typeof markdownToAdf>
  labels?: string[]
  priority?: { name: string } | null
}

export interface JiraSearchBody {
  jql: string
  maxResults: number
  fields: string[]
  nextPageToken?: string
}

export function normalizeComment(comment: z.infer<typeof commentSchema>): NormalizedTaskComment {
  return {
    externalId: comment.id,
    author: comment.author?.displayName ?? null,
    body: adfToMarkdown(comment.body),
    createdAt: Date.parse(comment.created),
  }
}

export function escapeJql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
