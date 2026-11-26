import type { TaskInvolvement, TaskProviderMetadata } from '@solus/contracts/task-data'
import type { z } from 'zod'
import type { IssueRef, IssueSource, IssueStatusCategory } from '@solus/contracts/task-sources'
import type {
  IssueAssigneeCandidate,
  IssueColumn,
  IssueEpic,
  IssueField,
  IssueKind,
  IssuePriority,
  IssueSourceHealth,
  IssueState,
  IssueStatusOptions,
  IssueUpdatePatch,
} from '@solus/contracts/task-types'
import type { AtlassianRequest } from '../../../atlassian/api'
import type { GitHubClient } from '../../../providers/github/octokit'
import type { AssetReference } from '../task-assets'

/**
 * The provider boundary of tasks (docs/plans/provider-owned-tasks.md §4.6).
 * GitHub and Jira own every task. An adapter reads the provider's words and
 * gives them in these shapes; nothing provider-shaped passes this file.
 */

/** What an adapter needs to write to one task. Stored as `issues.home`. */
/**
 * One Project item of a GitHub issue, with the ids that a write of its
 * priority or due date needs, so that the write reads nothing first.
 */
export interface GitHubBoardItem {
  projectId: string
  itemId: string
  priority?: { fieldId: string; options: Array<{ id: string; name: string }> }
  dueFieldId?: string
}

/** A Jira workflow transition and the status it reaches. */
export interface JiraTransition {
  id: string
  to: { id: string; name: string; statusCategory: { key: string } }
}

export type TaskHome =
  /**
   * `boardItems` is absent when the read could not see the Projects of the
   * issue. `canSetStatus` is absent when GitHub did not say whether this
   * connection may set the planning status.
   */
  | {
    provider: 'github'; kind: 'issue'; owner: string; repo: string; number: number
    boardItems?: GitHubBoardItem[]; canSetStatus?: boolean
  }
  /** A draft item has no repository: it is addressed by its Project and its item. */
  | { provider: 'github'; kind: 'draft'; projectId: string; itemId: string }
  /** `transitions` are the legal moves from the status of the read that gave them. */
  | { provider: 'jira'; cloudId: string; key: string; transitions?: JiraTransition[] }
  | { provider: 'linear'; workspaceId: string; issueId: string; teamId: string }

/** One task as a provider read gives it. */
export interface ProviderTask {
  ref: IssueRef
  kind: IssueKind
  /** `owner/repo#123` or `PROJ-12`. Absent on a draft. */
  reference?: string
  url: string | null
  title: string
  body: string
  state: IssueState
  /** The provider status id of `state`, where the provider supplies one. */
  stateId?: string
  assignees?: IssueAssigneeCandidate[]
  assignee?: string
  assigneeAvatarUrl?: string
  labels: string[]
  priority?: IssuePriority
  dueDate?: string
  /** A list read gives the epic with an empty `body`; `fetch` gives the body. */
  epic?: IssueEpic
  writableFields: IssueField[]
  home: TaskHome
  createdAt?: number
  updatedAt: number
}

export interface ProviderComment {
  /** The provider's id of the comment (a GitHub node id, a Jira comment id). */
  id: string
  /** The provider's name or login of the author. */
  author: string | null
  body: string
  createdAt: number
}

export interface ProviderTaskDetails {
  task: ProviderTask
  comments: ProviderComment[]
  /** The task has more comments than `comments` holds. */
  commentsTruncated: boolean
  providerMetadata?: TaskProviderMetadata
  statusOptions?: IssueStatusOptions
}

/** One task of a source, with where the source puts it. */
export interface SourceItem {
  task: ProviderTask
  /** A `IssueColumn.id` of the source; null for a board item with no column. */
  columnId: string | null
  /** The board item, for a write to a GitHub Project. Null in each other source. */
  itemId: string | null
}

/** What a source adapter needs to write to its source. Stored as `issue_sources.write_state`. */
export type SourceWriteState =
  | { kind: 'github-project'; projectId: string; statusFieldId: string | null }
  | {
    kind: 'jira-board'
    /** The project a new task of the board is created in. Null when the board has none. */
    projectKey: string | null
    /** The Jira status ids of each column, by `IssueColumn.id`. */
    columns: Array<{ columnId: string; statusIds: string[] }>
  }

export interface SourceRead {
  /** The source as a person reads it: `acme/app`, a Project's title, `SOL`, a board's name. */
  label: string
  /** The provider's columns in the provider's order. */
  columns: IssueColumn[]
  writeState: SourceWriteState | null
  /** At most `MAX_SOURCE_TASKS` tasks. */
  items: SourceItem[]
  /** The source holds more tasks than `items`. */
  truncated: boolean
  nextCursor?: string | null
}

/** What the first page of a source read gave, which its next pages keep. */
export type SourceReadHeld = Pick<SourceRead, 'label' | 'columns' | 'writeState'>

/** A list read of one source holds at most this many tasks. */
export const MAX_SOURCE_TASKS = 200

/** A new task, as a source adapter creates it. */
export interface TaskDraft {
  title: string
  body?: string
  /** A column of the source to start in. */
  columnId?: string
  assignees?: string[]
  assignee?: string | null
  dueDate?: string | null
  priority?: IssuePriority | null
  labels?: string[]
}

export interface SourceMove {
  source: IssueSource
  writeState: SourceWriteState | null
  home: TaskHome
  /** `SourceItem.itemId` of the task in this source. */
  itemId: string | null
  /** The `IssueColumn.id` to move to. */
  columnId: string
  /** The host's copy of the task, which the move answers from instead of a read. */
  current: ProviderTask
}

/** One adapter for each source kind. Each method refuses a source of another kind. */
export interface TaskSourceAdapter {
  readonly kind: IssueSource['kind']
  /**
   * The first page, or with `cursor` the next one. `held` is what the first
   * page gave: a next page uses it instead of reading the source's columns and
   * write state again.
   */
  read(source: IssueSource, cursor?: string, held?: SourceReadHeld): Promise<SourceRead>
  /** Ask the provider for the tasks of the source that match `query`. */
  search(source: IssueSource, query: string, involvement?: TaskInvolvement): Promise<ProviderTask[]>
  /** Create a task in the source. A GitHub Project source creates a draft item. */
  create(input: { source: IssueSource; writeState: SourceWriteState | null; draft: TaskDraft }): Promise<SourceItem>
  /**
   * Move a task to a column of the source. Answers the task after the move
   * when the move changed the task's own state (a repository, a Jira source),
   * and null when only the board placement changed (a GitHub Project).
   * A Jira move is a legal transition; it fails loudly when there is none.
   */
  move(input: SourceMove): Promise<ProviderTask | null>
  /** The people a new task of the source can be assigned to. Empty when the provider cannot say. */
  assignees(source: IssueSource): Promise<IssueAssigneeCandidate[]>
}

/** One adapter for each provider. It works from the task's `home`. */
export interface TaskProviderAdapter {
  readonly id: IssueRef['provider']
  /** Read one task by its stable id, with its comments and its epic. */
  fetch(ref: IssueRef, options?: { providerMetadata?: boolean }): Promise<ProviderTaskDetails>
  /** Change fields. Answers the task as the provider has it after the write. */
  /** `current` is the host's copy: an adapter answers it with the written
   *  fields instead of reading the issue again. */
  update(home: TaskHome, patch: IssueUpdatePatch, current: ProviderTask): Promise<ProviderTask>
  /**
   * Move the task's own state to a category. GitHub closes (`done`) or reopens
   * an issue. Jira makes a legal transition to a status of the category and
   * fails loudly when there is none. A GitHub draft has no state of its own.
   */
  setState(home: TaskHome, category: IssueStatusCategory, current: ProviderTask): Promise<ProviderTask>
  setNamedStatus?(home: TaskHome, statusId: string, current: ProviderTask): Promise<ProviderTask>
  comment(home: TaskHome, body: string): Promise<ProviderComment>
  assignees(home: TaskHome): Promise<IssueAssigneeCandidate[]>
  /** Upload the local assets that `body` references and answer the body to send. */
  publishAssets(home: TaskHome, body: string): Promise<string>
  /** The references in `body` that the provider cannot hold for this task. */
  unpublishableAssets(home: TaskHome, body: string): AssetReference[]
  /** Delete a draft item from its GitHub Project. Refuses each other task. */
  remove(home: TaskHome): Promise<void>
}

/** A failure that already knows what it means for the person's connection. */
export class TaskProviderError extends Error {
  constructor(readonly health: Exclude<IssueSourceHealth, 'ok'>, message: string) {
    super(message)
    this.name = 'TaskProviderError'
  }
}

/**
 * Run one GitHub operation with the acting person's credentials
 * (`runGithubRequest`). The client carries its `credential`: an asset upload is
 * signed with it.
 */
export type GithubRun = <Result>(
  operation: string,
  run: (client: GitHubClient) => Promise<Result>,
) => Promise<Result>

/** A Jira call that Atlassian refused, with the HTTP status. */
export class JiraRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'JiraRequestError'
  }
}

/** The acting person's Jira connection. A refused call throws `JiraRequestError`. */
export interface JiraTransport {
  request<Schema extends z.ZodType>(
    request: Omit<AtlassianRequest, 'product' | 'failure'>,
    schema: Schema,
  ): Promise<z.infer<Schema>>
  /** The site's address for links a person opens, or null when the site is not the connected one. */
  siteUrl(cloudId: string): Promise<string | null>
}
