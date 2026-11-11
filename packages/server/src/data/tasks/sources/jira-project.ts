import type { TaskSource } from '@solus/contracts/task-sources'
import type { TaskAssigneeCandidate, TaskColumn } from '@solus/contracts/task-types'
import { jiraStatusCategory } from '../status-category'
import { createJiraTask, readJiraTask, transitionJiraIssue } from '../providers/jira'
import {
  escapeJql,
  issueToTask,
  LIST_FIELDS,
  projectStatusesSchema,
  searchSchema,
  textClause,
  type JiraIssue,
  type JiraSearchBody,
} from '../providers/jira-model'
import {
  MAX_SOURCE_TASKS,
  type JiraTransport,
  type ProviderTask,
  type SourceItem,
  type SourceMove,
  type SourceRead,
  type SourceWriteState,
  type TaskDraft,
  type TaskSourceAdapter,
} from '../providers/types'

type JiraProject = Extract<TaskSource, { kind: 'jira-project' }>

const PAGE_SIZE = 50
const SEARCH_LIMIT = 100

function jiraProject(source: TaskSource): JiraProject {
  if (source.kind !== 'jira-project') throw new Error(`The Jira project source cannot read a ${source.kind} source.`)
  return source
}

/** The issues of one Jira project. Its columns are the statuses of its workflows. */
export class JiraProjectSource implements TaskSourceAdapter {
  readonly kind = 'jira-project' as const

  constructor(private readonly jira: JiraTransport) {}

  async read(source: TaskSource): Promise<SourceRead> {
    const { cloudId, projectKey } = jiraProject(source)
    const issues: JiraIssue[] = []
    let nextPageToken: string | undefined
    let truncated = false
    do {
      const body: JiraSearchBody = {
        jql: `project = "${escapeJql(projectKey)}" ORDER BY updated DESC`,
        maxResults: Math.min(PAGE_SIZE, MAX_SOURCE_TASKS - issues.length),
        fields: LIST_FIELDS,
      }
      if (nextPageToken) body.nextPageToken = nextPageToken
      const page = await this.jira.request(
        { cloudId, method: 'POST', path: '/rest/api/3/search/jql', body },
        searchSchema,
      )
      issues.push(...page.issues)
      nextPageToken = page.nextPageToken ?? undefined
      if (issues.length >= MAX_SOURCE_TASKS && (nextPageToken || page.isLast === false)) {
        truncated = true
        break
      }
      if (page.isLast === true || !nextPageToken) break
    } while (issues.length < MAX_SOURCE_TASKS)

    const siteUrl = await this.jira.siteUrl(cloudId)
    return {
      label: projectKey,
      columns: await this.columns(cloudId, projectKey),
      writeState: null,
      items: issues.slice(0, MAX_SOURCE_TASKS).map((issue) => {
        const task = issueToTask(issue, cloudId, siteUrl)
        return { task, columnId: task.stateId ?? null, itemId: null }
      }),
      truncated,
    }
  }

  /** Jira gives the statuses for each issue type. A column is a status, one
   *  time, in the sequence Jira first gives it. */
  private async columns(cloudId: string, projectKey: string): Promise<TaskColumn[]> {
    const issueTypes = await this.jira.request(
      { cloudId, path: `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses` },
      projectStatusesSchema,
    )
    const columns = new Map<string, TaskColumn>()
    for (const status of issueTypes.flatMap((issueType) => issueType.statuses)) {
      if (columns.has(status.id)) continue
      columns.set(status.id, {
        id: status.id,
        name: status.name,
        category: jiraStatusCategory(status.statusCategory.key),
      })
    }
    return [...columns.values()]
  }

  /**
   * A project larger than the cap cannot be searched by a filter of the list
   * Solus holds: the issue a person looks for is frequently an older one. The
   * text goes to Jira, which searches the whole project.
   */
  async search(source: TaskSource, query: string): Promise<ProviderTask[]> {
    const { cloudId, projectKey } = jiraProject(source)
    const body: JiraSearchBody = {
      jql: `project = "${escapeJql(projectKey)}" AND ${textClause(query)} ORDER BY updated DESC`,
      maxResults: SEARCH_LIMIT,
      fields: LIST_FIELDS,
    }
    const { issues } = await this.jira.request(
      { cloudId, method: 'POST', path: '/rest/api/3/search/jql', body },
      searchSchema,
    )
    const siteUrl = await this.jira.siteUrl(cloudId)
    return issues.map((issue) => issueToTask(issue, cloudId, siteUrl))
  }

  async create(input: {
    source: TaskSource
    writeState: SourceWriteState | null
    draft: TaskDraft
  }): Promise<SourceItem> {
    const { cloudId, projectKey } = jiraProject(input.source)
    const { columnId } = input.draft
    const task = await createJiraTask(this.jira, {
      cloudId,
      projectKey,
      draft: input.draft,
      statusIds: columnId ? [columnId] : null,
      columnName: `status ${columnId}`,
    })
    return { task, columnId: task.stateId ?? null, itemId: null }
  }

  async move(input: SourceMove): Promise<ProviderTask> {
    const { cloudId } = jiraProject(input.source)
    if (input.home.provider !== 'jira') throw new Error('A Jira project can move only a Jira issue.')
    // A column of a Jira project is one status, so the move is a transition to it.
    const statusId = input.columnId
    await transitionJiraIssue(this.jira, input.home, (to) => to.id === statusId, `status ${statusId}`)
    return (await readJiraTask(this.jira, cloudId, input.home.key)).task
  }

  /** Solus does not write the assignee of a Jira issue, so it lists no candidates. */
  async assignees(source: TaskSource): Promise<TaskAssigneeCandidate[]> {
    jiraProject(source)
    return []
  }
}
