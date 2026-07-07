// Task system data model — the single abstraction every layer talks to.
//
// A project picks exactly one task provider (`github | jira | linear | local`);
// the panel, session binding, and prompt injection only ever see `Task` —
// never a provider-native payload. See the "Task System Design" work for the
// full rationale (cache+sync, epics as grouped tasks, no two-way content sync).

export type TaskProviderId = 'github' | 'jira' | 'linear' | 'local'

/** `'epic'` = a parent that groups child tasks; `'task'` = a unit of work. */
export type TaskKind = 'task' | 'epic'

/** Normalized status, decoupled from any provider's raw state vocabulary. */
export type TaskStatus = 'open' | 'in_progress' | 'done'

/** Normalized priority (undefined = unset). For GitHub it's inferred from
 *  conventional priority labels; for local it's an explicit field. Drives the
 *  "what's next" sort and the priority badge. */
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low'

/** A pull request opened for a task — the outbound half of the session loop.
 *  Auto-captured from the session that worked on the task (branch → `gh pr view`),
 *  and editable for local tasks. Distinct from a GitHub ticket's read-only
 *  `linkedPrs` (those describe the upstream issue, this describes our work). */
export interface TaskPr {
  /** In an `updateTask` patch, an empty url is the clear sentinel (mirrors the
   *  `""` convention the other clearable fields use — `undefined` keys don't
   *  survive JSON transports, so absence can't mean "clear"). */
  url: string
  /** Parsed from the URL for compact display (`#123`); 0 if unparseable. */
  number: number
}

export interface Task {
  /** Provider-native id (issue number as string, `JIRA-123`, local uuid). */
  id: string
  providerId: TaskProviderId
  kind: TaskKind
  title: string
  /** Markdown description. */
  body: string
  /** Normalized status; carry the provider's raw state in `raw` if needed. */
  status: TaskStatus
  /** Deep link back to the source (null for local tasks). */
  url: string | null
  assignee?: string
  labels: string[]
  /** The epic this task belongs to, if any. */
  parentId?: string
  /** Optional provider-supplied child ids for hydrated epics. The UI groups by parentId. */
  childIds?: string[]
  /** Due date as an ISO calendar day (`YYYY-MM-DD`); drives sorting + overdue cues. */
  dueDate?: string
  /** Priority; drives the "what's next" sort and the priority badge. */
  priority?: TaskPriority
  /** Git branch the work happened on — auto-captured from the bound session. */
  branch?: string
  /** PR opened for this task — auto-captured (branch → `gh pr view`), editable. */
  pr?: TaskPr
  /** Whether due date + priority are editable for *this* task. Local tasks are
   *  always true; a GitHub issue is true only when it's on a Projects v2 board
   *  (those fields live on the project item, not the issue). Undefined ⇒ false. */
  canEditPlanningFields?: boolean
  updatedAt: string
  /** Full provider payload, kept for hydration / context injection at session start. */
  raw: unknown
}

/** One comment on a task, as providers surface it (also the shape stored in a
 *  task's `raw.comments`). Returned from `postComment` so callers can patch a
 *  just-posted comment into a stale re-read (GitHub's GraphQL reads lag its
 *  REST writes). */
export interface TaskCommentData {
  id?: string
  author: { login: string } | null
  body: string
  createdAt: string
}

/** A provider's list read. `truncated` marks a capped result (GitHub stops at
 *  its page budget) so the UI can say the list is partial instead of implying
 *  it is everything. */
export interface TaskList {
  tasks: Task[]
  truncated?: boolean
}

/** What `tasksList` returns to the renderer: the provider list plus how it was
 *  obtained — `fromCache` (+ `fetchedAt`) when a live fetch failed and the
 *  last-seen snapshot was served instead. */
export interface TaskListResult extends TaskList {
  fromCache?: boolean
  /** Epoch ms the served list was actually fetched from the provider. */
  fetchedAt?: number
}

export interface TaskProviderRepoRef {
  owner: string
  repo: string
}

export type TaskProviderStatusReason =
  | 'ok'
  | 'missing_github_repo'
  | 'github_not_connected'
  | 'github_access_failed'
  | 'unsupported_provider'

/** Project-scoped provider health for onboarding and repair UI. This is a
 *  lightweight preflight: it reports the configured provider, the resolved repo
 *  binding, auth state, and whether tasks can be listed without falling back. */
export interface TaskProviderStatus {
  provider: TaskProviderId
  ok: boolean
  reason: TaskProviderStatusReason
  message: string
  repo?: TaskProviderRepoRef & { source: 'config' | 'origin' }
  detectedRepo?: TaskProviderRepoRef
  auth?: {
    connected: boolean
    login?: string
    hasProjectScope?: boolean
  }
  liveCheck?: {
    checkedAt: number
    issueCount: number
    truncated?: boolean
    planningFieldsDetected?: boolean
  }
  warning?: string
}

/** Stable marker prepended to auth/connection failures from remote providers,
 *  so the renderer can offer "Connect GitHub" without sniffing error prose. */
export const TASKS_AUTH_ERROR_PREFIX = '[tasks-auth] '

/**
 * The interface the rest of the app depends on. `local` implements all of it;
 * third-party providers implement read + status-update and omit the optional
 * mutators (callers feature-detect via presence). A provider is bound to a
 * single project/repo at construction, so these methods take no repo argument.
 */
export interface TaskProvider {
  readonly id: TaskProviderId
  /** `assignedToMe` scopes to the viewer. */
  listTasks(opts?: { assignedToMe?: boolean }): Promise<TaskList>
  /** Hydrated: full body, comments, linked PRs, sub-issue links (in `raw`). */
  getTask(id: string): Promise<Task>
  createTask?(input: Partial<Task>): Promise<Task>
  updateTask?(id: string, patch: Partial<Task>): Promise<Task>
  /** Local-only; upstream providers omit it (we don't delete remote tickets). */
  deleteTask?(id: string): Promise<boolean>
  /** Post a comment upstream — used by the "started in Solus" write-back when a
   *  session binds to a task and by the detail view's composer. Only providers
   *  with a comment model implement it; returns the created comment. */
  postComment?(id: string, body: string): Promise<TaskCommentData>
}

/** A Solus session linked to a task, surfaced on the task card as a back-link so
 *  the user can jump from a ticket to the work happening on it. Stored locally
 *  (never written upstream) keyed by task id — see `task-links.ts`. */
export interface TaskSessionLink {
  sessionId: string
  /** Epoch ms the link was recorded; drives "most recent session" ordering. */
  linkedAt: number
}

/** Build a `TaskPr` from a PR/MR URL, parsing the number for display. Shared so
 *  the capture path (main) and the renderer agree on the shape. Returns null for
 *  an empty url so callers can pass through cleanly. */
export function taskPrFromUrl(url: string | null | undefined): TaskPr | undefined {
  if (!url) return undefined
  // GitHub `/pull/123`, GitLab `/-/merge_requests/123`; fall back to a trailing number.
  const m = url.match(/\/(?:pull|merge_requests)\/(\d+)/) ?? url.match(/(\d+)\s*$/)
  return { url, number: m ? Number(m[1]) : 0 }
}
