// Native local-first task data model shared across the host and every client.
// Configured upstream tickets use the same normalized rendering contract while
// retaining provider ownership.

import type { WorkType } from './types'

export type TaskProviderId = 'github' | 'jira' | 'local'

/** `'epic'` = a parent that groups child tasks; `'task'` = a unit of work. */
export type TaskKind = 'task' | 'epic'

/** The one task lifecycle, shared by local tasks and upstream tickets. Upstream
 * providers normalize their states into this vocabulary at their own boundary
 * (e.g. an open GitHub issue reads as `todo`). */
export type TaskStatus =
  | 'inbox'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'dropped'

export type TaskTitleSource = 'prompt' | 'generated' | 'manual'
export type TaskSource = 'user' | 'agent' | 'automation' | 'import' | 'session'
export type TaskSessionRole = 'working' | 'referenced'
export type TaskSyncState = 'ok' | 'dirty' | 'error' | 'auth_error'

export interface ExternalTicketRef {
  provider: Exclude<TaskProviderId, 'local'>
  /** Provider-owned scope: `owner/repo` on GitHub, `<cloudId>/<projectKey>` on
   *  Jira. Opaque to everything outside that provider's adapter. */
  externalKey: string
  externalId: string
  url: string
}

/** A task field the sync engine can hold a pending local write for. Whether a
 *  given provider can actually take one is the adapter's own declaration. */
export type TaskSyncField = 'title' | 'body' | 'status' | 'labels' | 'priority' | 'assignee'

export interface TaskExternalLink extends ExternalTicketRef {
  taskId: string
  externalUpdatedAt?: string | null
  snapshot?: unknown
  dirtyFields: TaskSyncField[]
  syncState: TaskSyncState
  syncError?: string | null
  lastSyncedAt?: number | null
  retryAt?: number | null
  failureCount: number
}

export interface NormalizedTaskComment {
  externalId: string
  author?: string | null
  body: string
  createdAt: number
}

export interface NormalizedTicket extends ExternalTicketRef {
  title: string
  body: string
  /** The upstream state, already spoken in the one Solus vocabulary. Adapters
   *  report the finest status they can genuinely observe — GitHub can only see
   *  `todo`/`in_progress`/`done`, Jira can name a real "In Review" — and
   *  `TaskSyncAdapter.statusKey` states which of these are indistinguishable
   *  upstream, so the engine never mistakes coarseness for a real change. */
  status: TaskStatus
  labels: string[]
  assignee?: string
  assigneeAvatarUrl?: string
  externalUpdatedAt: string
  comments: NormalizedTaskComment[]
  snapshot?: unknown
  priorityHint?: TaskPriority
}

export interface TicketPatch {
  title?: string
  body?: string
  /** Full local fidelity. An adapter that cannot express a status collapses it
   *  itself; the engine must not decide that on the provider's behalf. */
  status?: TaskStatus
  labels?: string[]
  priority?: TaskPriority | null
  assignee?: string | null
}

/** A person the configured task provider permits an issue to be assigned to. */
export interface TaskAssigneeCandidate {
  login: string
  avatarUrl?: string
}

export interface CandidateTicket extends ExternalTicketRef {
  title: string
  status: TaskStatus
  labels: string[]
  externalUpdatedAt: string
  priorityHint?: TaskPriority
}

export interface TaskCandidateOptions {
  query?: string
  limit?: number
  /** Provider-native attention filter. Used by the cross-project inbox; normal
   * project lists omit it and continue to show the complete bound scope. */
  involvement?: import('./inbox-types').InboxInvolvement
}

/** Normalized priority (undefined = unset). For GitHub it's inferred from
 *  conventional priority labels; for local it's an explicit field. Drives the
 *  "what's next" sort and the priority badge. */
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low'

/** A pull request attached to a task. Hydrated from the issue's active linked
 *  PR for GitHub tickets; local rows only carry one captured by earlier
 *  versions. Distinct from a GitHub ticket's read-only `linkedPrs` (those
 *  describe the upstream issue, this describes our work). */
export interface TaskPr {
  url: string
  /** Parsed from the URL for compact display (`#123`); 0 if unparseable. */
  number: number
}

/** One durable PR edge needed by the lightweight sidebar snapshot. */
export interface TaskSidebarPrLink {
  number: number
  url?: string
  title?: string
  targetScope?: string
  createdBy?: TaskActor | 'migration'
  /** Session whose checkout established this automatic link. This lets a live
   * checkout replace stale system discovery without distrusting user links. */
  originSessionId?: string
}

/**
 * The upstream ticket a native task mirrors, once it has been published or
 * imported. Ownership stays local — every read and write still goes through the
 * native path — but surfaces name the provider, because that is where other
 * people see this work. Absent on a task that lives only in Solus.
 */
export interface TaskMirroredTicket {
  provider: Exclude<TaskProviderId, 'local'>
  externalId: string
  url: string
}

export interface Task {
  /** Globally unique local id (a ULID for local tasks, the issue number for
   * upstream ones). */
  id: string
  /** `local` for Solus-owned tasks; anything else marks an upstream ticket the
   * renderer routes through the `tasks*Upstream` RPCs. */
  providerId: TaskProviderId
  /** Human-referenceable per-install id, rendered as `T-<n>`. */
  shortId?: number
  /** Null/undefined means the global inbox. */
  projectKey?: string | null
  kind: TaskKind
  title: string
  titleSource?: TaskTitleSource
  /** Markdown description. */
  body: string
  /** Normalized status; carry the provider's raw state in `raw` if needed. */
  status: TaskStatus
  /** Deep link back to the source (null for local tasks). */
  url: string | null
  /** The upstream ticket this native task is linked to, when there is one. */
  mirroredTicket?: TaskMirroredTicket
  assignee?: string
  /** Provider-hosted avatar for the assignee, when the provider exposes one. */
  assigneeAvatarUrl?: string
  labels: string[]
  /** The epic this task belongs to, if any. */
  parentId?: string
  /** Optional provider-supplied child ids for hydrated epics. The UI groups by parentId. */
  childIds?: string[]
  /** Due date as an ISO calendar day (`YYYY-MM-DD`); drives sorting + overdue cues. */
  dueDate?: string
  /** Priority; drives the "what's next" sort and the priority badge. */
  priority?: TaskPriority
  /** PR opened for this task — auto-captured (branch → `gh pr view`), editable. */
  pr?: TaskPr
  /** Whether due date + priority are editable for *this* task. Local tasks are
   *  always true; a GitHub issue is true only when it's on a Projects v2 board
   *  (those fields live on the project item, not the issue). Undefined ⇒ false. */
  canEditPlanningFields?: boolean
  source?: TaskSource
  originSessionId?: string
  originAutomationId?: string
  createdAt?: number
  /** Epoch milliseconds. Providers parse their own timestamp format into this. */
  updatedAt: number
  triagedAt?: number
  doneAt?: number
  /** Last time the task rollup was visited or explicitly marked read. */
  lastReadAt?: number
  /** Full provider payload, kept for hydration / context injection at session start. */
  raw?: unknown
}

export interface TaskListFilter {
  projectKey?: string | null
  status?: TaskStatus | TaskStatus[]
  parentId?: string | null
  scope?: 'all' | 'inbox' | 'project' | 'up_next'
}

export interface TaskCreateInput {
  title: string
  projectKey?: string | null
  parentId?: string | null
  body?: string
  status?: TaskStatus
  kind?: TaskKind
  assignee?: string | null
  dueDate?: string | null
  priority?: TaskPriority | null
  labels?: string[]
  source?: TaskSource
  originSessionId?: string | null
  originAutomationId?: string | null
}

export interface TaskUpdatePatch {
  projectKey?: string | null
  parentId?: string | null
  title?: string
  body?: string
  status?: TaskStatus
  kind?: TaskKind
  assignee?: string | null
  dueDate?: string | null
  priority?: TaskPriority | null
  labels?: string[]
}

/** First-class local comment. Upstream provider comments stay in the task's
 * `raw` payload (`TaskCommentData`) and are only rendered, never stored. */
export interface TaskComment {
  id: string
  taskId: string
  author?: string | null
  source: 'local' | 'external'
  externalId?: string | null
  originSessionId?: string | null
  body: string
  createdAt: number
  /** True only when this local-first comment was explicitly queued upstream. */
  syncPending?: boolean
}

/** What a task can be linked to. `work` is the storage noun for what the
 *  picker labels "Docs" (the `works` table, `WorkReference`); the renderer maps
 *  at that one boundary. `session` is deliberately absent: session bindings
 *  keep living in `task_session_links`, which carries role/branch/injection
 *  state a plain link cannot. */
export type TaskLinkKind = 'work' | 'plan' | 'pr' | 'automation'

/** Who caused a task mutation. There is no user identity in Solus, so `user`
 *  means "someone acting in the app", not a named account. */
export type TaskActor = 'user' | 'agent' | 'automation' | 'system'

/** An explicit edge from a task to another workspace object.
 *
 *  Identity is `(kind, targetScope, targetKey)`:
 *  - `work`       scope `''`,          key = `works.id`
 *  - `plan`       scope = `sessionId`, key = `planToolUseId` (`planKey()` joins them)
 *  - `automation` scope `''`,          key = `automations.id`
 *  - `pr`         scope = repo identity (or a legacy repo root), key = the PR
 *    number as a string
 *
 *  `title`/`url` are the link-time snapshot, so a row always renders — even for
 *  a PR (remote) or a target that has since been deleted. `liveTitle` and
 *  `liveStatus` are re-derived per read by joining the target's table, and are
 *  absent for kinds that do not live in this database (`pr`). */
export interface TaskLink {
  taskId: string
  kind: TaskLinkKind
  targetScope: string
  targetKey: string
  title: string
  url?: string | null
  liveTitle?: string
  liveStatus?: string
  createdBy: TaskActor | 'migration'
  originSessionId?: string
  linkedAt: number
}

/** The identity of a link target — the key a reverse lookup takes. */
export interface TaskLinkTarget {
  kind: TaskLinkKind
  targetScope: string
  targetKey: string
}

/** A task that links a target, as a conversation card names it: enough to
 *  label the edge and open the task, never the task's full record. */
export interface TaskLinkedTask extends TaskLinkTarget {
  taskId: string
  title: string
  status: TaskStatus
  shortId?: number
  projectKey?: string | null
}

/** What a caller passes to link something; the store fills in the snapshot
 *  title it can resolve and the timestamp. */
export interface TaskLinkInput {
  kind: TaskLinkKind
  targetScope?: string
  targetKey: string
  /** Snapshot label. When omitted the store resolves it from the target's
   *  table; a `pr` without a title falls back to `#<number>`. */
  title?: string
  url?: string | null
  createdBy?: TaskActor
  originSessionId?: string | null
}

/** Task history, interleaved with `TaskComment[]` to build the activity feed.
 *  Comments deliberately have no event of their own — `task_comments` already
 *  is that log, and a mirrored row would be a second thing to keep in sync. */
export type TaskEventKind =
  | 'created'
  | 'status_changed'
  | 'priority_changed'
  | 'assignee_changed'
  | 'due_date_changed'
  | 'title_changed'
  | 'parent_changed'
  | 'labels_changed'
  | 'linked'
  | 'unlinked'
  | 'session_started'


export interface TaskEvent {
  id: string
  taskId: string
  kind: TaskEventKind
  actor: TaskActor
  /** Display name when there is one (an agent's session, an automation). */
  actorLabel?: string
  /** Previous / next scalar, already stringified. `labels_changed` holds JSON. */
  from?: string | null
  to?: string | null
  /** Only on `linked` / `unlinked` / `session_started`. */
  targetKind?: TaskLinkKind | 'session'
  targetScope?: string
  targetKey?: string
  targetTitle?: string
  createdAt: number
}

/** The detail read deliberately carries no session links. Attempts live in one
 * place — the renderer's `sessionsByTask`, fed by `taskSessions()` — because a
 * second copy on this object could only ever disagree with it, and the detail
 * surfaces that would render it are the ones that overwrite it. */
export interface TaskDetails {
  task: Task
  subtasks: Task[]
  comments: TaskComment[]
  links: TaskLink[]
  /** Newest-last, capped at `TASK_EVENT_LIMIT`. Merge with `comments` by
   *  timestamp to build the activity feed. */
  events: TaskEvent[]
  /** The external ticket this native task synchronizes with, when linked. */
  externalLink?: TaskExternalLink
}

export interface TaskForSessionResult {
  task: Task
  parent: Task | null
  subtasks: Task[]
  siblings: Task[]
  attempts: TaskSessionLink[]
}

/** One authoritative renderer snapshot for native task rows and their session
 * ownership. These collections are read together so the sidebar never has to
 * reconcile independently timed task and link responses. */
/**
 * What a client sends to a host to mint (or bind) the task a session is about
 * to start under.
 *
 * There is no `sessionId`: the session does not exist yet at first dispatch, and
 * the execution host — which may be a different machine entirely — issues it.
 * The link is written afterwards through `tasksLinkSession`.
 */
export interface PrepareSessionTaskRequest {
  /** Bind this task instead of minting a new one. */
  existingTaskId?: string | null
  /** Mint the new task as a direct child of this one. */
  parentTaskId?: string | null
  projectKey?: string | null
  /** The first prompt, whose first non-empty line deterministically names the task. */
  prompt?: string
  /** Also return a `TaskSnapshot` of the minted/bound task. Set by a client
   *  about to dispatch to a different execution host, which needs the snapshot
   *  to ride the prompt (see docs/plans/dispatch-parity.md). */
  includeSnapshot?: boolean
}

export interface PrepareSessionTaskResult {
  task: Task | null
  /** Present only when `includeSnapshot` was requested and a task was bound. */
  snapshot: TaskSnapshot | null
}

/** A read-only copy of a content-bearing linked item — a work's document or a
 *  plan's markdown — shipped alongside the snapshot for dispatched sessions:
 *  the execution host cannot read the task host's stores, so
 *  `read_work`/`read_plan`/`list_works` answer from these copies. PR and
 *  automation links ship no content: their facts (title, url, live status)
 *  already ride `TaskDetails.links`. */
export interface TaskLinkedItemSnapshot {
  kind: 'work' | 'plan'
  /** The link's target key: a work id, or a plan's `planToolUseId`. */
  key: string
  /** The link's target scope: `''` for works; the plan's owning session id. */
  scope: string
  title: string
  /** Works only: how the content renders. */
  workType?: WorkType
  content: string
  updatedAt?: string
}

/**
 * The serializable task state a dispatched prompt carries: exactly what
 * `formatTaskContext` consumes, so the execution host renders the packet from
 * it verbatim and serves `read_task` from the same shape. Assembled on the
 * task's own host; never persisted on the execution host.
 */
export interface TaskSnapshot {
  details: TaskDetails
  parent: TaskDetails | null
  sessions: TaskSessionLink[]
  /** Full content of the task's content-bearing linked items (works, plans),
   *  so the dispatched agent can read the documents its task points at.
   *  Absent on snapshots from older hosts. */
  linked?: TaskLinkedItemSnapshot[]
}

export interface TaskSidebarSnapshot {
  tasks: Task[]
  sessionsByTask: Record<string, TaskSessionLink[]>
  /** Newest link for clients that predate multi-PR task links. */
  prLinksByTask?: Record<string, TaskSidebarPrLink>
  /** Every durable PR edge, newest first. */
  prLinkListsByTask?: Record<string, TaskSidebarPrLink[]>
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

interface TaskProviderRepoRef {
  owner: string
  repo: string
}

/** Why a project's task provider is or is not usable. Provider-neutral: a
 *  second provider must not need a second copy of the same four outcomes.
 *  Which system is being talked about is `provider`. */
type TaskProviderStatusReason =
  | 'ok'
  /** The provider is chosen but not pointed at anything — no repo, no project. */
  | 'missing_binding'
  | 'not_connected'
  | 'access_failed'
  | 'unsupported_provider'

/** Project-scoped provider health for onboarding and repair UI. This is a
 *  lightweight preflight: it reports the configured provider, the resolved
 *  binding, auth state, and whether tasks can be listed without falling back. */
export interface TaskProviderStatus {
  provider: TaskProviderId
  ok: boolean
  reason: TaskProviderStatusReason
  message: string
  /** The binding as the user reads it — `owner/repo`, or a Jira project key.
   *  Every provider fills this; `repo` below stays GitHub's own shape for the
   *  repair UI that compares it with the checkout's detected repository. */
  scopeLabel?: string
  repo?: TaskProviderRepoRef & { source: 'config' | 'origin' }
  detectedRepo?: TaskProviderRepoRef
  /** Fields an unstored provider ticket accepts as immediate writes. */
  writableFields?: TaskSyncField[]
  /** The distinct statuses this provider can represent. */
  statuses?: TaskStatus[]
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
 * Where a session ran, as only the client that dispatched it can state it.
 *
 * Sent with the link because that is the first moment a session id exists, and
 * because neither host can work it out alone: the execution host cannot name
 * itself, and the task's host never sees the session at all. The receiving host
 * records both the attempt and a stub session row, so the session — not the
 * link — is what later reads ask where the work happened.
 */
export interface SessionExecutionHost {
  /** The saved-host id the client knows the execution machine by. Only ever
   *  sent for a dispatch, so it always names a machine other than the one
   *  holding the task. */
  serverId: string
  /** Which agent ran it, so the task's host can say so without the transcript. */
  provider?: string
  /** The project root as the *user* knows it. The agent's own checkout is a path
   *  on the borrowed machine and means nothing here. */
  projectRoot?: string | null
}

/** A Solus session linked to a task, surfaced on the task card as a back-link so
 *  the user can jump from a ticket to the work happening on it. Stored locally
 *  (never written upstream) keyed by task id — see `task-sessions.ts`. */
export interface TaskSessionLink {
  taskId?: string
  sessionId: string
  /** Display title from the indexed session's custom title or first message.
   *  Required, not optional: a reader that skips the `sessions` join produces a
   *  link that is structurally identical to a complete one, and every display
   *  surface then silently falls back to the owning task's name or a raw
   *  session id. Stating the field forces that read to fail at compile time
   *  instead. `null` means "the session is not indexed yet" — a real answer. */
  sessionTitle: string | null
  /** Agent that ran the session, as the session index stores it (`claude`,
   *  `codex`, `opencode`). Null for a link whose session is not indexed yet. */
  provider: string | null
  /** Resolved model that ran the session. Null until the session is indexed. */
  model: string | null
  /** Start of the stable Solus session lineage. Null when the session is not
   *  indexed yet. This is session chronology, unlike `linkedAt`, which can be
   *  later when a task is created after work begins. */
  startedAt: number | null
  lastActivityAt: number | null
  /** Session-owned execution host, projected through the task/session join.
   *  Null means the task host for older and non-dispatched attempts. */
  executionServerId?: string | null
  role?: TaskSessionRole
  /** Session-owned checkout branch, projected through the relationship. */
  branch?: string
  /** Whether that branch is the session's own worktree rather than a clone it
   *  shares. Git state is held per working directory, so every attempt running
   *  in one checkout reports the same branch — a fact about the checkout, not
   *  about the session. Only an isolated one may claim a pull request.
   *  Undefined where the session is not indexed yet, which claims nothing. */
  isolatedCheckout?: boolean
  pr?: TaskPr
  /** Epoch ms the link was recorded; drives "most recent session" ordering. */
  linkedAt: number
}
