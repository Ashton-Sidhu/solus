import type { TaskInvolvement } from '@solus/contracts/task-data'
import type { TaskSource } from '@solus/contracts/task-sources'
import type { TaskAssigneeCandidate, TaskColumn } from '@solus/contracts/task-types'
import { githubProjectOptionCategory } from '../status-category'
import { githubUserId, readDraftItem } from '../providers/github'
import { searchGithubIssues, withPlanningStatus } from '../providers/github-planning-status'
import {
  ADD_DRAFT_MUTATION,
  draftToTask,
  issueToTask,
  PROJECT_QUERY,
  PROJECT_STATUS_QUERY,
  pushToCap,
  restIssueToTask,
  SET_PROJECT_FIELD_MUTATION,
  statusValueOf,
  type AddDraftResponse,
  type ProjectItemNode,
  type ProjectResponse,
} from '../providers/github-model'
import {
  TaskProviderError,
  type GithubRun,
  type ProviderTask,
  type SourceItem,
  type SourceMove,
  type SourceRead,
  type SourceWriteState,
  type TaskDraft,
  type TaskSourceAdapter,
} from '../providers/types'

type ProjectSource = Extract<TaskSource, { kind: 'github-project' }>
type ProjectWriteState = Extract<SourceWriteState, { kind: 'github-project' }>

function projectSource(source: TaskSource): ProjectSource {
  if (source.kind !== 'github-project') {
    throw new Error(`The GitHub Project source cannot read a ${source.kind} source.`)
  }
  return source
}

function projectWriteState(writeState: SourceWriteState | null): ProjectWriteState {
  if (writeState?.kind !== 'github-project') {
    throw new Error('Solus has not read this GitHub Project yet. Refresh the task source, then try again.')
  }
  return writeState
}

/** A board item as a task with its column. Null for a pull request and for
 *  content that the viewer cannot see. */
function sourceItem(node: ProjectItemNode | null, projectId: string): SourceItem | null {
  const content = node?.content
  if (!node || !content || content.__typename === 'PullRequest') return null
  const status = statusValueOf(node.fieldValues)
  const task = content.__typename === 'Issue'
    ? issueToTask(content)
    : draftToTask(content, { projectId, itemId: node.id, statusName: status?.name ?? null })
  return { task, columnId: status?.optionId ?? null, itemId: node.id }
}

/**
 * The items of one GitHub Project (Projects v2). Its columns are the options of
 * its Status field. A new task of the source is a draft item. The token needs
 * the `project` scope: an `INSUFFICIENT_SCOPES` error passes unchanged.
 */
export class GitHubProjectSource implements TaskSourceAdapter {
  readonly kind = 'github-project' as const

  constructor(private readonly run: GithubRun) {}

  async read(source: TaskSource, continuation?: string): Promise<SourceRead> {
    const { owner, number } = projectSource(source)
    return this.run('read_github_project', async ({ graphql }) => {
      const items: SourceItem[] = []
      let cursor: string | null = continuation ?? null
      let pages = 0
      for (;;) {
        pages++
        const res: ProjectResponse = await withPlanningStatus((preview) =>
          graphql<ProjectResponse>(preview ? PROJECT_STATUS_QUERY : PROJECT_QUERY, { owner, number, cursor }))
        const project = res.repositoryOwner?.projectV2
        if (!project) {
          throw new TaskProviderError(
            'no_access',
            `GitHub Project ${owner}/${number} does not exist, or this GitHub connection cannot read it.`,
          )
        }
        const page = project.items.nodes.flatMap((node) => {
          const item = sourceItem(node, project.id)
          return item ? [item] : []
        })
        // At the cap, one more page can hold only pull requests, so Solus does
        // not read to the end of the Project to know: more items is `truncated`.
        const { hasNextPage } = project.items.pageInfo
        const truncated = pushToCap(items, page) || (pages >= 4 && hasNextPage)
        if (!truncated && hasNextPage) {
          cursor = project.items.pageInfo.endCursor
          continue
        }
        const statusField = project.fields.nodes.find((field) =>
          field?.dataType === 'SINGLE_SELECT' && field.name?.toLowerCase() === 'status')
        const columns: TaskColumn[] = (statusField?.options ?? []).map((option) => ({
          id: option.id,
          name: option.name,
          category: githubProjectOptionCategory(option.name),
        }))
        return {
          label: project.title,
          columns,
          writeState: { kind: 'github-project', projectId: project.id, statusFieldId: statusField?.id ?? null },
          items,
          truncated,
          nextCursor: hasNextPage ? project.items.pageInfo.endCursor : null,
        }
      }
    })
  }

  /** GitHub has no search of one Project, so the search is a filter of the source read. */
  async search(source: TaskSource, query: string, involvement: TaskInvolvement = 'all'): Promise<ProviderTask[]> {
    if (involvement !== 'all') {
      const { owner, number } = projectSource(source)
      return this.run('search_github_project_involvement', async ({ rest, graphql }) => {
        const q = [`project:${owner}/${number}`, 'is:issue', involvement === 'authored' ? 'author:@me' : involvement === 'assigned' ? 'assignee:@me' : 'mentions:@me', query.trim()].filter(Boolean).join(' ')
        const results = await searchGithubIssues(graphql, q)
        if (results) return results
        const response = await rest.search.issuesAndPullRequests({ q, per_page: 100, sort: 'updated' })
        return response.data.items.map((issue) => {
          const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(issue.repository_url)
          if (!match) throw new Error('GitHub returned an issue without a repository.')
          return restIssueToTask(issue, { owner: match[1], repo: match[2] })
        })
      })
    }
    const { items } = await this.read(source)
    const needle = query.trim().toLowerCase()
    return items
      .map((item) => item.task)
      .filter((task) =>
        task.title.toLowerCase().includes(needle) || (task.reference ?? '').toLowerCase().includes(needle))
  }

  async create(input: {
    source: TaskSource
    writeState: SourceWriteState | null
    draft: TaskDraft
  }): Promise<SourceItem> {
    projectSource(input.source)
    const { projectId, statusFieldId } = projectWriteState(input.writeState)
    const { draft } = input
    if (draft.labels?.length || draft.priority || draft.dueDate) {
      throw new Error('A draft item of a GitHub Project takes a title, a body and an assignee only.')
    }
    const columnId = draft.columnId
    if (columnId && !statusFieldId) throw new Error('This GitHub Project has no Status field, so it has no columns.')
    return this.run('create_github_draft', async ({ graphql }) => {
      const res = await graphql<AddDraftResponse>(ADD_DRAFT_MUTATION, {
        projectId,
        title: draft.title,
        body: draft.body,
        assigneeIds: draft.assignees ? await Promise.all(draft.assignees.map((login) => githubUserId(graphql, login))) : draft.assignee ? [await githubUserId(graphql, draft.assignee)] : undefined,
      })
      const item = res.addProjectV2DraftIssue.projectItem
      if (!columnId) {
        return {
          task: draftToTask(item.content, { projectId, itemId: item.id, statusName: null }),
          columnId: null,
          itemId: item.id,
        }
      }
      await graphql(SET_PROJECT_FIELD_MUTATION, {
        projectId,
        itemId: item.id,
        fieldId: statusFieldId,
        value: { singleSelectOptionId: columnId },
      })
      // The state of a draft is the name of its Status option, which only the board item gives.
      return { task: await readDraftItem(graphql, item.id), columnId, itemId: item.id }
    })
  }

  /** A move changes only the placement on the board, so there is no task to answer. */
  async move(input: SourceMove): Promise<null> {
    projectSource(input.source)
    const { projectId, statusFieldId } = projectWriteState(input.writeState)
    if (!statusFieldId) throw new Error('This GitHub Project has no Status field, so it has no columns.')
    const itemId = input.itemId
    if (!itemId) throw new Error('This task is not an item of the GitHub Project, so it cannot be moved on it.')
    await this.run('move_github_project_item', ({ graphql }) =>
      graphql(SET_PROJECT_FIELD_MUTATION, {
        projectId,
        itemId,
        fieldId: statusFieldId,
        value: { singleSelectOptionId: input.columnId },
      }))
    return null
  }

  /** GitHub cannot list the people a draft item can be assigned to. */
  async assignees(source: TaskSource): Promise<TaskAssigneeCandidate[]> {
    projectSource(source)
    return []
  }
}
