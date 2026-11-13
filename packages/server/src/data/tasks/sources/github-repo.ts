import type { TaskSource } from '@solus/contracts/task-sources'
import type { TaskAssigneeCandidate } from '@solus/contracts/task-types'
import { createRepoIssue, GitHubTaskProvider, listRepoAssignees, withoutProjectScope } from '../providers/github'
import {
  issueToTask,
  pushToCap,
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

  async read(source: TaskSource): Promise<SourceRead> {
    const { owner, repo } = repoSource(source)
    return this.run('list_github_tasks', async ({ graphql }) => {
      const items: SourceItem[] = []
      let truncated = false
      // Open issues first, then closed issues with the remaining budget: the
      // recently closed issues of a busy repository must not push open work
      // out of the capped list.
      outer: for (const states of [['OPEN'], ['CLOSED']]) {
        let cursor: string | null = null
        for (;;) {
          const res: ListIssuesResponse = await withoutProjectScope((queries) => graphql<ListIssuesResponse>(queries.listIssues, {
            owner,
            repo,
            states,
            cursor,
          }))
          const page = res.repository.issues
          truncated = pushToCap(items, page.nodes.map((node) => repoSourceItem(issueToTask(node))))
          if (truncated) break outer
          if (!page.pageInfo.hasNextPage) break
          cursor = page.pageInfo.endCursor
        }
      }
      return {
        label: `${owner}/${repo}`,
        columns: [
          { id: 'open', name: 'Open', category: 'open' },
          { id: 'closed', name: 'Closed', category: 'done' },
        ],
        writeState: null,
        items,
        truncated,
      }
    })
  }

  /**
   * The list holds only the most recent issues, so a search asks GitHub: a
   * filter of the capped list would not find an older issue. A text search
   * looks for one issue, which is as often a closed one.
   */
  async search(source: TaskSource, query: string): Promise<ProviderTask[]> {
    const { owner, repo } = repoSource(source)
    return this.run('search_github_tasks', async ({ rest }) => {
      const response = await rest.search.issuesAndPullRequests({
        q: [`repo:${owner}/${repo}`, 'is:issue', query.trim()].filter(Boolean).join(' '),
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
