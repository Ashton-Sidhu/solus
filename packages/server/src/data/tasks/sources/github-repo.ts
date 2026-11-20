import { z } from 'zod'
import type { TaskInvolvement } from '@solus/contracts/task-data'
import type { TaskSource } from '@solus/contracts/task-sources'
import type { TaskAssigneeCandidate } from '@solus/contracts/task-types'
import { createRepoIssue, GitHubTaskProvider, listRepoAssignees, withoutProjectScope } from '../providers/github'
import {
  issueToTask,
  repoSourceItem,
  restIssueToTask,
  type ListIssuesResponse,
} from '../providers/github-model'
import type {
  GithubRun,
  ProviderTask,
  SourceItem,
  SourceMove,
  SourceRead,
  SourceWriteState,
  TaskDraft,
  TaskSourceAdapter,
} from '../providers/types'

type RepoSource = Extract<TaskSource, { kind: 'github-repo' }>

function repoSource(source: TaskSource): RepoSource {
  if (source.kind !== 'github-repo') throw new Error(`The GitHub repository source cannot read a ${source.kind} source.`)
  return source
}

function closesIssue(columnId: string): boolean {
  if (columnId === 'closed') return true
  if (columnId === 'open') return false
  throw new Error(`A GitHub repository has the columns Open and Closed only, not ${columnId}.`)
}

/** The issues of one GitHub repository. Its columns are the two states of an issue. */
export class GitHubRepoSource implements TaskSourceAdapter {
  readonly kind = 'github-repo' as const

  private readonly provider: GitHubTaskProvider

  constructor(private readonly run: GithubRun) {
    this.provider = new GitHubTaskProvider(run)
  }

  async read(source: TaskSource, continuation?: string): Promise<SourceRead> {
    const { owner, repo } = repoSource(source)
    const start = continuation
      ? z.object({ state: z.enum(['OPEN', 'CLOSED']), cursor: z.string().nullable() }).parse(JSON.parse(continuation))
      : { state: 'OPEN' as const, cursor: null }
    return this.run('list_github_tasks', async ({ graphql }) => {
      const items: SourceItem[] = []
      let state = start.state
      let cursor = start.cursor
      let nextCursor: string | null = null
      // Four physical pages bound a click even if GitHub returns short pages.
      for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
        const res: ListIssuesResponse = await withoutProjectScope((queries) => graphql<ListIssuesResponse>(queries.listIssues, { owner, repo, states: [state], cursor }))
        const page = res.repository.issues
        items.push(...page.nodes.map((node) => repoSourceItem(issueToTask(node))))
        if (page.pageInfo.hasNextPage) cursor = page.pageInfo.endCursor
        else if (state === 'OPEN') { state = 'CLOSED'; cursor = null }
        else { nextCursor = null; break }
        nextCursor = JSON.stringify({ state, cursor })
      }
      return { label: `${owner}/${repo}`, columns: [{ id: 'open', name: 'Open', category: 'open' }, { id: 'closed', name: 'Closed', category: 'done' }], writeState: null, items, truncated: nextCursor !== null, nextCursor }
    })
  }

  /**
   * The list holds only the most recent issues, so a search asks GitHub: a
   * filter of the capped list would not find an older issue. A text search
   * looks for one issue, which is as often a closed one.
   */
  async search(source: TaskSource, query: string, involvement: TaskInvolvement = 'all'): Promise<ProviderTask[]> {
    const { owner, repo } = repoSource(source)
    return this.run('search_github_tasks', async ({ rest }) => {
      const response = await rest.search.issuesAndPullRequests({
        q: [`repo:${owner}/${repo}`, 'is:issue', involvement === 'authored' ? 'author:@me' : involvement === 'assigned' ? 'assignee:@me' : involvement === 'mentioned' ? 'mentions:@me' : '', query.trim()].filter(Boolean).join(' '),
        sort: 'updated',
        order: 'desc',
        per_page: 100,
        page: 1,
      })
      return response.data.items.map((issue) => restIssueToTask(issue, { owner, repo }))
    })
  }

  async create(input: {
    source: TaskSource
    writeState: SourceWriteState | null
    draft: TaskDraft
  }): Promise<SourceItem> {
    const { owner, repo } = repoSource(input.source)
    const { draft } = input
    if (draft.priority || draft.dueDate) {
      throw new Error('A new GitHub issue takes no priority or due date. Set them on a GitHub Project.')
    }
    const closed = draft.columnId !== undefined && closesIssue(draft.columnId)
    return repoSourceItem(await createRepoIssue(this.run, { owner, repo }, draft, closed))
  }

  async move(input: SourceMove): Promise<ProviderTask | null> {
    repoSource(input.source)
    return this.provider.setState(input.home, closesIssue(input.columnId) ? 'done' : 'open')
  }

  async assignees(source: TaskSource): Promise<TaskAssigneeCandidate[]> {
    return listRepoAssignees(this.run, repoSource(source))
  }
}
