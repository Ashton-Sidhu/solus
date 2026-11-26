import { z } from 'zod'
import type { TaskProviderData, TaskProviderEvent } from '@solus/contracts/task-data'
import type { IssueEpic, IssuePriority } from '@solus/contracts/task-types'
import { adfBodySchema, adfToMarkdown, type markdownToAdf } from '../../../atlassian/adf'
import { jiraStatusCategory } from '../status-category'
import type { ProviderComment, ProviderTask } from './types'

/** The Jira words of a task: the schemas of the answers Solus reads, and the
 *  mappers to `ProviderTask`. */

export const PRIORITY_TO_JIRA = {
  urgent: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
} satisfies Record<IssuePriority, string>

export function priorityFromJira(name: string | undefined): IssuePriority | undefined {
  if (!name) return undefined
  if (/highest|blocker/i.test(name)) return 'urgent'
  if (/high|critical/i.test(name)) return 'high'
  if (/medium|major|normal/i.test(name)) return 'medium'
  if (/low|lowest|minor|trivial/i.test(name)) return 'low'
  return undefined
}

/** A Jira status. Its id is the column of a Jira project, and a board column lists it. */
const statusSchema = z.object({
  id: z.string(),
  name: z.string(),
  statusCategory: z.object({ key: z.string() }),
})

export const commentSchema = z.object({
  id: z.string(),
  author: z.object({ displayName: z.string().nullish() }).nullish(),
  body: adfBodySchema,
  created: z.string(),
})

export const issueSchema = z.object({
  /** The numeric id, which stays when the key changes. */
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string().nullish(),
    description: adfBodySchema,
    created: z.string().nullish(),
    updated: z.string(),
    labels: z.array(z.string()).nullish(),
    status: statusSchema,
    priority: z.object({ name: z.string() }).nullish(),
    assignee: z.object({
      displayName: z.string().nullish(),
      avatarUrls: z.record(z.string(), z.string()).nullish(),
    }).nullish(),
    /** The epic (or, for a subtask, its parent issue). Jira gives the summary
     *  here but never the description. */
    parent: z.object({
      key: z.string(),
      fields: z.object({ summary: z.string().nullish() }).nullish(),
    }).nullish(),
    comment: z.object({
      total: z.number().nullish(),
      comments: z.array(commentSchema),
    }).nullish(),
  }),
})

export type JiraIssue = z.infer<typeof issueSchema>

export const searchSchema = z.object({
  issues: z.array(issueSchema),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
})
const transitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  to: statusSchema,
})
export const transitionsSchema = z.object({ transitions: z.array(transitionSchema) })
export type JiraTransitionTarget = z.infer<typeof statusSchema>

/** One change of an issue: a `histories` entry of `expand=changelog`, or a
 *  `values` entry of a `/changelog` page. Both carry the same id. */
const changeSchema = z.object({
  id: z.string(),
  created: z.string(),
  author: z.object({ displayName: z.string() }).nullish(),
  items: z.array(z.object({ field: z.string(), fromString: z.string().nullish(), toString: z.string().nullish() })),
})

/** The issue of a detail read: its fields, its newest changes and its legal transitions, in one answer. */
export const issueDetailSchema = issueSchema.extend({
  changelog: z.object({ total: z.number(), histories: z.array(changeSchema) }).nullish(),
  transitions: z.array(transitionSchema).nullish(),
})
export const ISSUE_DETAIL_EXPAND = 'changelog,transitions'

/** A page of `/rest/api/3/issue/{id}/changelog`, oldest first. */
export const changelogPageSchema = z.object({
  startAt: z.number(),
  total: z.number(),
  values: z.array(changeSchema),
})

export const JIRA_PROVIDER_CAPABILITIES: TaskProviderData['capabilities'] = {
  history: true, reactions: false, multipleAssignees: false, templates: false,
}

export function changeEvents(changes: Array<z.infer<typeof changeSchema>>): TaskProviderEvent[] {
  return changes.flatMap((change) => change.items.map((item, index) => ({
    id: `${change.id}:${index}`,
    at: Date.parse(change.created),
    actor: change.author?.displayName ?? null,
    text: `changed ${item.field} from “${item.fromString ?? 'none'}” to “${item.toString ?? 'none'}”`,
  })))
}

export const createdIssueSchema = z.object({ id: z.string(), key: z.string() })
export const epicIssueSchema = z.object({
  fields: z.object({ summary: z.string().nullish(), description: adfBodySchema }),
})
export const issueTypesSchema = z.object({
  issueTypes: z.array(z.object({ id: z.string(), name: z.string(), subtask: z.boolean().nullish() })),
})

/** What the attachment endpoint answers: one entry for each file sent, with
 *  the authenticated URL that serves its bytes. */
export const attachmentsSchema = z.array(z.object({
  id: z.string(),
  filename: z.string(),
  content: z.string(),
}))

/** `/rest/api/3/project/{key}/statuses`: the statuses of each issue type. */
export const projectStatusesSchema = z.array(z.object({ statuses: z.array(statusSchema) }))

/** `/rest/api/3/status`: each status of the site, for the category of a board column. */
export const siteStatusesSchema = z.array(z.object({
  id: z.string(),
  statusCategory: z.object({ key: z.string() }),
}))

export const boardSchema = z.object({
  name: z.string(),
  location: z.object({ projectKey: z.string().nullish() }).nullish(),
})
export const boardConfigurationSchema = z.object({
  columnConfig: z.object({
    columns: z.array(z.object({
      name: z.string(),
      statuses: z.array(z.object({ id: z.string() })).nullish(),
    })),
  }),
})
export const boardIssuesSchema = z.object({
  issues: z.array(issueSchema),
  total: z.number().nullish(),
})

/** A response body that nothing reads: a 204 from an issue update or a transition. */
export const IGNORED_RESPONSE = z.unknown()

export const ISSUE_FIELDS = 'summary,description,status,labels,priority,assignee,created,updated,comment,parent'
export const LIST_FIELDS = ['summary', 'description', 'status', 'labels', 'priority', 'assignee', 'created', 'updated', 'parent']

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

export function escapeJql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** `~` is the text match of JQL. The escaped quotes prevent a read of the query as JQL syntax. */
export function textClause(query: string): string {
  const text = escapeJql(query.trim())
  return `(summary ~ "${text}" OR key = "${text}")`
}

/**
 * The link a person opens must address the site by its hostname:
 * `api.atlassian.com` needs a bearer token. Null when the site is not the
 * connected one.
 */
export function browseUrl(siteUrl: string | null, key: string): string | null {
  return siteUrl ? `${siteUrl}/browse/${key}` : null
}

/** The parent as the epic, without its description: that is one more read. */
export function parentEpic(issue: JiraIssue, siteUrl: string | null): IssueEpic | undefined {
  const parent = issue.fields.parent
  if (!parent) return undefined
  return {
    provider: 'jira',
    externalId: parent.key,
    url: browseUrl(siteUrl, parent.key) ?? '',
    title: parent.fields?.summary ?? parent.key,
    body: '',
  }
}

export function issueToTask(issue: JiraIssue, cloudId: string, siteUrl: string | null): ProviderTask {
  const { fields } = issue
  const created = fields.created ? Date.parse(fields.created) : NaN
  return {
    ref: { provider: 'jira', cloudId, id: issue.id },
    kind: 'issue',
    reference: issue.key,
    url: browseUrl(siteUrl, issue.key),
    title: fields.summary ?? issue.key,
    body: adfToMarkdown(fields.description),
    state: { name: fields.status.name, category: jiraStatusCategory(fields.status.statusCategory.key) },
    stateId: fields.status.id,
    assignee: fields.assignee?.displayName ?? undefined,
    assigneeAvatarUrl: fields.assignee?.avatarUrls?.['48x48'],
    labels: fields.labels ?? [],
    priority: priorityFromJira(fields.priority?.name),
    epic: parentEpic(issue, siteUrl),
    // Priority is a plain Jira field. A project that hides it refuses the
    // write with a reason that names the field, which is better than silence.
    writableFields: ['title', 'body', 'labels', 'priority'],
    home: { provider: 'jira', cloudId, key: issue.key },
    createdAt: Number.isNaN(created) ? undefined : created,
    updatedAt: Date.parse(fields.updated) || 0,
  }
}

export function commentFromJira(comment: z.infer<typeof commentSchema>): ProviderComment {
  return {
    id: comment.id,
    author: comment.author?.displayName ?? null,
    body: adfToMarkdown(comment.body),
    createdAt: Date.parse(comment.created) || 0,
  }
}
