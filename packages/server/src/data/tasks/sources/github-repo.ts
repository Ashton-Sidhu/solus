import { z } from 'zod'
import type { TaskInvolvement } from '@solus/contracts/task-data'
import type { IssueSource } from '@solus/contracts/task-sources'
import type { IssueAssigneeCandidate, IssueColumn } from '@solus/contracts/task-types'
import { createRepoIssue, GitHubTaskProvider, listRepoAssignees } from '../providers/github'
import { readGithubIssues, rememberPlanningStatuses, searchGithubIssues } from '../providers/github-planning-status'
import {
  GITHUB_PAGE_SIZE,
  issueToTask,
  planningColumn,
  planningStatusesOf,
  repoSourceItem,
  restIssueToTask,
  type ListIssuesResponse,
} from '../providers/github-model'
import {
  MAX_SOURCE_TASKS,
  type GithubRun,
  type ProviderTask,
  type SourceItem,
  type SourceMove,
  type SourceRead,
  type SourceWriteState,
  type TaskDraft,
  type TaskSourceAdapter,
} from '../providers/types'

type RepoSource = Extract<IssueSource, { kind: 'github-repo' }>

function repoSource(source: IssueSource): RepoSource {
  if (source.kind !== 'github-repo') throw new Error(`The GitHub repository source cannot read a ${source.kind} source.`)
  return source
}

const LEGACY_COLUMNS: IssueColumn[] = [
  { id: 'open', name: 'Open', category: 'open' },
  { id: 'closed', name: 'Closed', category: 'done' },
]

/** The issues of one GitHub repository, grouped by its own states. */
export class GitHubRepoSource implements TaskSourceAdapter {
  readonly kind = 'github-repo' as const

  private readonly provider: GitHubTaskProvider

  constructor(private readonly run: GithubRun) {
    this.provider = new GitHubTaskProvider(run)
  }

  async read(source: IssueSource, continuation?: string): Promise<SourceRead> {
    const { owner, repo } = repoSource(source)
    const start = continuation
      ? z.object({ state: z.enum(['OPEN', 'CLOSED']), cursor: z.string().nullable() }).parse(JSON.parse(continuation))
      : { state: 'OPEN' as const, cursor: null }
    return this.run('list_github_tasks', async ({ graphql }) => {
      const items: SourceItem[] = []
      let columns = LEGACY_COLUMNS
      let state = start.state
      let cursor = start.cursor
      let nextCursor: string | null = null
      // Four physical pages bound a click even if GitHub returns short pages.
      // Each page asks for no more than the cap leaves, so no read cuts a page
      // and its cursor never skips an issue.
      for (let pageIndex = 0; pageIndex < 4 && items.length < MAX_SOURCE_TASKS; pageIndex++) {
        const first = Math.min(GITHUB_PAGE_SIZE, MAX_SOURCE_TASKS - items.length)
        const res: ListIssuesResponse = await readGithubIssues(graphql, (queries) => graphql<ListIssuesResponse>(queries.listIssues, { owner, repo, states: [state], cursor, first }))
        const statuses = planningStatusesOf(res.repository)
        if (pageIndex === 0 && res.repository.planningStatuses) rememberPlanningStatuses(graphql, { owner, repo }, statuses)
        if (pageIndex === 0 && statuses.length) columns = statuses.map(planningColumn)
        const page = res.repository.issues
        items.push(...page.nodes.map((node) => repoSourceItem(issueToTask(node), columns !== LEGACY_COLUMNS)))
        if (page.pageInfo.hasNextPage) cursor = page.pageInfo.endCursor
        else if (state === 'OPEN') { state = 'CLOSED'; cursor = null }
        else { nextCursor = null; break }
        nextCursor = JSON.stringify({ state, cursor })
      }
      return { label: `${owner}/${repo}`, columns, writeState: null, items, truncated: nextCursor !== null, nextCursor }
    })
  }

  /**
   * The list holds only the most recent issues, so a search asks GitHub: a
   * filter of the capped list would not find an older issue. A text search
   * looks for one issue, which is as often a closed one.
   */
  async search(source: IssueSource, query: string, involvement: TaskInvolvement = 'all'): Promise<ProviderTask[]> {
    const { owner, repo } = repoSource(source)
    return this.run('search_github_tasks', async ({ rest, graphql }) => {
      const q = [`repo:${owner}/${repo}`, 'is:issue', involvement === 'authored' ? 'author:@me' : involvement === 'assigned' ? 'assignee:@me' : involvement === 'mentioned' ? 'mentions:@me' : '', query.trim()].filter(Boolean).join(' ')
      const results = await searchGithubIssues(graphql, q)
      if (results) return results
      const response = await rest.search.issuesAndPullRequests({
        q,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
        page: 1,
      })
      return response.data.items.map((issue) => restIssueToTask(issue, { owner, repo }))
    })
  }

  async create(input: {
    source: IssueSource
    writeState: SourceWriteState | null
    draft: TaskDraft
  }): Promise<SourceItem> {
    const { owner, repo } = repoSource(input.source)
    const { draft } = input
    if (draft.priority || draft.dueDate) {
      throw new Error('A new GitHub issue takes no priority or due date. Set them on a GitHub Project.')
    }
    const { columnId } = draft
    const statusId = columnId && columnId !== 'open' && columnId !== 'closed' ? columnId : undefined
    return repoSourceItem(await createRepoIssue(this.run, { owner, repo }, draft, columnId === 'closed', statusId))
  }

  async move(input: SourceMove): Promise<ProviderTask | null> {
    repoSource(input.source)
    if (input.columnId === 'open' || input.columnId === 'closed') {
      return this.provider.setState(input.home, input.columnId === 'closed' ? 'done' : 'open', input.current)
    }
    return this.provider.setNamedStatus(input.home, input.columnId, input.current)
  }

  async assignees(source: IssueSource): Promise<IssueAssigneeCandidate[]> {
    return listRepoAssignees(this.run, repoSource(source))
  }
}
