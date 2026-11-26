import type { TaskInvolvement } from '@solus/contracts/task-data'
import type { IssueSource } from '@solus/contracts/task-sources'
import type { IssueAssigneeCandidate, IssueColumn } from '@solus/contracts/task-types'
import { jiraStatusCategory } from '../status-category'
import { createJiraTask, movedJiraTask, transitionJiraIssue } from '../providers/jira'
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
  type SourceReadHeld,
  type SourceWriteState,
  type TaskDraft,
  type TaskSourceAdapter,
} from '../providers/types'

type JiraProject = Extract<IssueSource, { kind: 'jira-project' }>

const PAGE_SIZE = 100
const SEARCH_LIMIT = 100

function jiraProject(source: IssueSource): JiraProject {
  if (source.kind !== 'jira-project') throw new Error(`The Jira project source cannot read a ${source.kind} source.`)
  return source
}

/** The issues of one Jira project. Its columns are the statuses of its workflows. */
export class JiraProjectSource implements TaskSourceAdapter {
  readonly kind = 'jira-project' as const

  constructor(private readonly jira: JiraTransport) {}

  async read(source: IssueSource, continuation?: string, held?: SourceReadHeld): Promise<SourceRead> {
    const { cloudId, projectKey } = jiraProject(source)
    const issues: JiraIssue[] = []
    let nextPageToken: string | undefined = continuation
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
      columns: held?.columns ?? await this.columns(cloudId, projectKey),
      writeState: null,
      items: issues.slice(0, MAX_SOURCE_TASKS).map((issue) => {
        const task = issueToTask(issue, cloudId, siteUrl)
        return { task, columnId: task.stateId ?? null, itemId: null }
      }),
      truncated,
      nextCursor: truncated ? nextPageToken ?? null : null,
    }
  }

  /** Jira gives the statuses for each issue type. A column is a status, one
   *  time, in the sequence Jira first gives it. */
  private async columns(cloudId: string, projectKey: string): Promise<IssueColumn[]> {
    const issueTypes = await this.jira.request(
      { cloudId, path: `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses` },
      projectStatusesSchema,
    )
    const columns = new Map<string, IssueColumn>()
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
  async search(source: IssueSource, query: string, involvement: TaskInvolvement = 'all'): Promise<ProviderTask[]> {
    if (involvement === 'mentioned') throw new Error('Jira does not expose a reliable mentioned-by-me issue search. Open Jira to use its mention notifications.')
    const { cloudId, projectKey } = jiraProject(source)
    const body: JiraSearchBody = {
      jql: `project = "${escapeJql(projectKey)}" AND ${[query.trim() ? textClause(query) : '', involvement === 'authored' ? 'reporter = currentUser()' : involvement === 'assigned' ? 'assignee = currentUser()' : ''].filter(Boolean).join(' AND ') || 'created IS NOT EMPTY'} ORDER BY updated DESC`,
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
    source: IssueSource
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
    jiraProject(input.source)
    if (input.home.provider !== 'jira') throw new Error('A Jira project can move only a Jira issue.')
    // A column of a Jira project is one status, so the move is a transition to it.
    const statusId = input.columnId
    const to = await transitionJiraIssue(this.jira, input.home, (status) => status.id === statusId, `status ${statusId}`)
    return movedJiraTask(input.current, to)
  }

  /** Solus does not write the assignee of a Jira issue, so it lists no candidates. */
  async assignees(source: IssueSource): Promise<IssueAssigneeCandidate[]> {
    jiraProject(source)
    return []
  }
}
