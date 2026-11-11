import type { z } from 'zod'
import type { TaskSource } from '@solus/contracts/task-sources'
import type { TaskAssigneeCandidate, TaskColumn } from '@solus/contracts/task-types'
import type { AtlassianRequest } from '../../../atlassian/api'
import { jiraStatusCategory } from '../status-category'
import { createJiraTask, readJiraTask, transitionJiraIssue } from '../providers/jira'
import {
  boardConfigurationSchema,
  boardIssuesSchema,
  boardSchema,
  issueToTask,
  LIST_FIELDS,
  siteStatusesSchema,
  textClause,
  type JiraIssue,
} from '../providers/jira-model'
import {
  JiraRequestError,
  MAX_SOURCE_TASKS,
  TaskProviderError,
  type JiraTransport,
  type ProviderTask,
  type SourceItem,
  type SourceMove,
  type SourceRead,
  type SourceWriteState,
  type TaskDraft,
  type TaskSourceAdapter,
} from '../providers/types'

type JiraBoard = Extract<TaskSource, { kind: 'jira-board' }>
type BoardWriteState = Extract<SourceWriteState, { kind: 'jira-board' }>

const PAGE_SIZE = 50

function jiraBoard(source: TaskSource): JiraBoard {
  if (source.kind !== 'jira-board') throw new Error(`The Jira board source cannot read a ${source.kind} source.`)
  return source
}

function boardWriteState(writeState: SourceWriteState | null): BoardWriteState {
  if (writeState?.kind !== 'jira-board') {
    throw new Error('Solus has not read this Jira board yet. Refresh the task source, then try again.')
  }
  return writeState
}

/** The Jira status ids of one column of the board. */
function columnStatusIds(writeState: BoardWriteState, columnId: string): string[] {
  const column = writeState.columns.find((candidate) => candidate.columnId === columnId)
  if (!column) throw new Error(`This Jira board has no column ${columnId}.`)
  return column.statusIds
}

/** The column that lists the status, or null when no column of the board does. */
function columnOf(writeState: BoardWriteState, statusId: string | undefined): string | null {
  if (!statusId) return null
  return writeState.columns.find((column) => column.statusIds.includes(statusId))?.columnId ?? null
}

/**
 * The issues of one Jira board, read with the Agile API of Jira Software. A
 * column of the board lists one or more statuses, and its id is its name.
 */
export class JiraBoardSource implements TaskSourceAdapter {
  readonly kind = 'jira-board' as const

  constructor(private readonly jira: JiraTransport) {}

  /**
   * One call to the Agile API. The Atlassian connection can be good for Jira
   * and still not have the Jira Software permission, so a refusal here means
   * "connect again", not "the connection is broken".
   */
  private async agile<Schema extends z.ZodType>(
    board: JiraBoard,
    request: Pick<AtlassianRequest, 'path' | 'query'>,
    schema: Schema,
  ): Promise<z.infer<Schema>> {
    try {
      return await this.jira.request({ cloudId: board.cloudId, ...request }, schema)
    } catch (error) {
      if (error instanceof JiraRequestError && (error.status === 401 || error.status === 403)) {
        throw new TaskProviderError(
          'reconnect',
          'Connect Atlassian again to give Solus the Jira Software permission that boards need.',
        )
      }
      if (error instanceof JiraRequestError && error.status === 404) {
        throw new TaskProviderError(
          'no_access',
          `Jira board ${board.boardId} does not exist, or this Atlassian connection cannot read it.`,
        )
      }
      throw error
    }
  }

  private issuesPage(board: JiraBoard, jql: string, startAt: number) {
    return this.agile(
      board,
      {
        path: `/rest/agile/1.0/board/${board.boardId}/issue`,
        query: {
          fields: LIST_FIELDS.join(','),
          maxResults: String(PAGE_SIZE),
          startAt: String(startAt),
          jql,
        },
      },
      boardIssuesSchema,
    )
  }

  async read(source: TaskSource): Promise<SourceRead> {
    const board = jiraBoard(source)
    const boardPath = `/rest/agile/1.0/board/${board.boardId}`
    const [details, configuration, siteStatuses] = await Promise.all([
      this.agile(board, { path: boardPath }, boardSchema),
      this.agile(board, { path: `${boardPath}/configuration` }, boardConfigurationSchema),
      this.jira.request({ cloudId: board.cloudId, path: '/rest/api/3/status' }, siteStatusesSchema),
    ])

    const categoryKeyByStatusId = new Map(siteStatuses.map((status) => [status.id, status.statusCategory.key]))
    const columns: TaskColumn[] = []
    const writeState: BoardWriteState = {
      kind: 'jira-board',
      projectKey: details.location?.projectKey ?? null,
      columns: [],
    }
    for (const column of configuration.columnConfig.columns) {
      const statusIds = (column.statuses ?? []).map((status) => status.id)
      // The category of a column is the category of its first status. A column
      // with no status holds no issue, and is `open`.
      const categoryKey = statusIds[0] ? categoryKeyByStatusId.get(statusIds[0]) : undefined
      columns.push({ id: column.name, name: column.name, category: jiraStatusCategory(categoryKey ?? '') })
      writeState.columns.push({ columnId: column.name, statusIds })
    }

    const issues: JiraIssue[] = []
    let truncated = false
    for (;;) {
      const page = await this.issuesPage(board, 'ORDER BY updated DESC', issues.length)
      issues.push(...page.issues)
      const total = page.total ?? issues.length
      if (issues.length >= MAX_SOURCE_TASKS) {
        truncated = total > MAX_SOURCE_TASKS
        break
      }
      if (!page.issues.length || issues.length >= total) break
    }

    const siteUrl = await this.jira.siteUrl(board.cloudId)
    return {
      label: details.name,
      columns,
      writeState,
      items: issues.slice(0, MAX_SOURCE_TASKS).map((issue) => {
        const task = issueToTask(issue, board.cloudId, siteUrl)
        return { task, columnId: columnOf(writeState, task.stateId), itemId: null }
      }),
      truncated,
    }
  }

  /** The text goes to Jira, which searches each issue of the board, not only the list Solus holds. */
  async search(source: TaskSource, query: string): Promise<ProviderTask[]> {
    const board = jiraBoard(source)
    const { issues } = await this.issuesPage(board, textClause(query), 0)
    const siteUrl = await this.jira.siteUrl(board.cloudId)
    return issues.map((issue) => issueToTask(issue, board.cloudId, siteUrl))
  }

  async create(input: {
    source: TaskSource
    writeState: SourceWriteState | null
    draft: TaskDraft
  }): Promise<SourceItem> {
    const { cloudId } = jiraBoard(input.source)
    const writeState = boardWriteState(input.writeState)
    if (!writeState.projectKey) throw new Error('This board has no project. Create the task in Jira.')
    const { columnId } = input.draft
    // An unknown column must fail before the issue exists.
    const statusIds = columnId ? columnStatusIds(writeState, columnId) : null
    const task = await createJiraTask(this.jira, {
      cloudId,
      projectKey: writeState.projectKey,
      draft: input.draft,
      statusIds,
      columnName: columnId ?? '',
    })
    return { task, columnId: columnOf(writeState, task.stateId), itemId: null }
  }

  /** A legal transition to one of the statuses of the column. */
  async move(input: SourceMove): Promise<ProviderTask> {
    const { cloudId } = jiraBoard(input.source)
    const statusIds = columnStatusIds(boardWriteState(input.writeState), input.columnId)
    if (input.home.provider !== 'jira') throw new Error('A Jira board can move only a Jira issue.')
    await transitionJiraIssue(this.jira, input.home, (to) => statusIds.includes(to.id), input.columnId)
    return (await readJiraTask(this.jira, cloudId, input.home.key)).task
  }

  /** Solus does not write the assignee of a Jira issue, so it lists no candidates. */
  async assignees(source: TaskSource): Promise<TaskAssigneeCandidate[]> {
    jiraBoard(source)
    return []
  }
}
