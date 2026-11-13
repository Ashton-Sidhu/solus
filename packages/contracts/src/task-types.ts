// The task model shared across the host and every client. GitHub and Jira own
// every task: Solus reads them from the task sources a project lists, writes a
// change to the provider, and adds only its own attachments
// (docs/plans/provider-owned-tasks.md).

import type { AgentId, WorkType } from './types'
import type { Attribution } from './user'
import type { Activity } from './activity'
import type { TaskSource, TaskStatusCategory } from './task-sources'

export type TaskProviderId = 'github' | 'jira'

/** A GitHub issue or a Jira issue is an `issue`. A `draft` is a GitHub Project
 *  item that is not an issue yet: it has no repository, reference or URL. */
export type TaskKind = 'issue' | 'draft'

/** How a session relates to a task. `working` is an attempt; `referenced` is
 *  a relationship, not ownership. */
export type TaskSessionRole = 'working' | 'referenced'

/** The provider's own state of a task, in the provider's words: a Jira status,
 *  or `Open` / `Closed` on GitHub. */
export interface TaskState {
  name: string
  category: TaskStatusCategory
}

/** A status grouping that a task source owns: a GitHub Project Status option, a
 *  Jira board column, `Open` / `Closed` for a repository, a workflow status of
 *  a Jira project. Solus shows the provider's names in the provider's order. */
export interface TaskColumn {
  id: string
  name: string
  category: TaskStatusCategory
}

/** Where a task is in one source that lists it. `columnId` is null for a board
 *  item that has no column yet. */
export interface TaskPlacement {
  sourceKey: string
  columnId: string | null
}

/** A task field that Solus can send a change of to the provider. Which of them
 *  one task takes is `Task.writableFields`. */
export type TaskField = 'title' | 'body' | 'labels' | 'assignee' | 'priority' | 'dueDate'

/**
 * The epic (a Jira parent, a GitHub parent issue) a task belongs to, as a
 * snapshot taken on each read. Solus shows it and gives its description to the
 * agent; it never creates, moves, or closes one.
 */
export interface TaskEpic {
  provider: TaskProviderId
  /** The epic as a person reads it: an issue number or a Jira key. */
  externalId: string
  url: string
  title: string
  /** The epic's description, as the provider renders it. Injected into the task packet. */
  body: string
}

/** A person the provider permits a task to be assigned to. */
export interface TaskAssigneeCandidate {
  login: string
  avatarUrl?: string
}

/** Normalized priority (undefined = unset). On GitHub it is read from a
 *  board's Priority field, or from conventional priority labels off a board.
 *  Drives the "what's next" sort and the priority badge. */
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low'

/** The newest pull request linked to a task in Solus, for compact display. */
export interface TaskPr {
  url: string
  /** Parsed from the URL for compact display (`#123`); 0 if unparseable. */
  number: number
}

/** Last host observation for a linked PR. It is display state, not a merge permission. */
export interface TaskPrSnapshot {
  number: number
  url: string
  title: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  updatedAt: string
  baseRepo: { host: string; owner: string; repo: string }
}

/**
 * One pull request of a task, as the lightweight sidebar snapshot carries it:
 * a link made on the task itself, or a link that one of the task's sessions
 * owns (docs/plans/session-pull-requests.md).
 */
export interface TaskSidebarPrLink {
  /** What PR sync last saw. Absent until it first answers. */
  snapshot?: TaskPrSnapshot
  /** The code host says that this pull request does not exist. */
  missing?: boolean
  number: number
  url?: string
  title?: string
  targetScope?: string
  createdBy?: Attribution
  /** The session that made a link on the task itself. */
  originSessionId?: string
  /** The session that owns this link. Absent on a link made on the task
   *  itself. Unlinking an owned link removes it from the session. */
  ownerSessionId?: string
}

export interface Task {
  /** The task key (`taskKey` in `task-sources.ts`): the only id of a task. */
  id: string
  providerId: TaskProviderId
  kind: TaskKind
  /** The task as a person reads it: `owner/repo#123` or `PROJ-12`. Absent on a draft. */
  reference?: string
  title: string
  /** Markdown description. */
  body: string
  /** Deep link to the task on its provider. Null for a draft. */
  url: string | null
  state: TaskState
  /** The one coarse status of the task: `done` when the provider closed it,
   *  `active` when its state or one of its columns is active, else `open`. */
  category: TaskStatusCategory
  /** The sources that list the task, with its column in each. */
  placements: TaskPlacement[]
  assignee?: string
  /** Provider-hosted avatar for the assignee, when the provider exposes one. */
  assigneeAvatarUrl?: string
  labels: string[]
  /** The epic this task belongs to. Set only from a provider read. */
  epic?: TaskEpic
  /** Due date as an ISO calendar day (`YYYY-MM-DD`); drives sorting + overdue cues. */
  dueDate?: string
  /** Priority; drives the "what's next" sort and the priority badge. */
  priority?: TaskPriority
  /** The newest pull request linked to the task in Solus. */
  pr?: TaskPr
  /** The fields the provider takes a change of for this task. A GitHub issue
   *  takes a priority or a due date only when a Project it is on has that field. */
  writableFields: TaskField[]
  /** Epoch milliseconds, as the provider reports them. */
  createdAt?: number
  updatedAt: number
  /** Last time the task was visited or explicitly marked read on this host. */
  lastReadAt?: number
  /** The reading person's own snooze (`TaskSnooze`), in epoch ms: their task
   *  lists hide the task until then. A host never sends it on a task record; a
   *  client fills it from `tasksSnoozes`, so one person's snooze never reaches
   *  another. A time in the past is a snooze that ended and was not yet seen. */
  snoozedUntil?: number
  /** The reminder the reading person wrote with their snooze. */
  snoozeNote?: string
}

/** One person's snooze of a task (docs/task-snooze.md). Only that person reads
 *  it: the task stays in everyone else's lists, and its status and agents do
 *  not change. */
export interface TaskSnooze {
  taskId: string
  /** Epoch ms. A time in the past is a snooze that ended and was not yet woken. */
  snoozedUntil: number
  snoozeNote?: string
}

/** A new task. It is created on the provider, in one of the person's task
 *  sources. A GitHub Project source creates a draft item. */
export interface TaskCreateInput {
  source: TaskSource
  title: string
  body?: string
  /** A column of the source to start in. Absent = where the provider starts a task. */
  columnId?: string
  assignee?: string | null
  dueDate?: string | null
  priority?: TaskPriority | null
  labels?: string[]
}

/** A change of a task's fields, sent to the provider. A field outside the
 *  task's `writableFields` is refused. */
export interface TaskUpdatePatch {
  title?: string
  body?: string
  assignee?: string | null
  dueDate?: string | null
  priority?: TaskPriority | null
  labels?: string[]
}

/** Where to move a task: to one column of one source that lists it, or to a
 *  status category, where the host chooses the column of each source. */
export type TaskMoveTarget =
  | { sourceKey: string; columnId: string }
  | { category: TaskStatusCategory }

/** A comment on a task. Each comment is a provider comment; one that Solus
 *  could not send yet is `unsent` and stays on this host until it is sent or
 *  discarded. */
export interface TaskComment {
  id: string
  taskId: string
  /** Who wrote a comment that Solus sent or holds. Absent on a comment that
   *  Solus only read from the provider. */
  author?: Attribution
  /** The provider's name or login for the author of a comment read from it. */
  externalAuthor?: string | null
  originSessionId?: string | null
  body: string
  createdAt: number
  /** The comment is not on the provider yet. */
  unsent?: boolean
  /** Why the last send failed. */
  sendError?: string
}

/** What a task can be linked to. `work` is the storage noun for what the
 *  picker labels "Docs" (the `works` table, `WorkReference`); the renderer maps
 *  at that one boundary. `session` is deliberately absent: a session binding is
 *  the task's `works-on` or `reference` edge, which carries a role a plain link
 *  cannot (`TaskSessionLink`). */
export type TaskLinkKind = 'work' | 'plan' | 'pr' | 'automation'

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
  /** Who made the link. `system` is a link Solus made by itself. */
  createdBy: Attribution
  originSessionId?: string
  /** The session of the task that the link comes from. For a `pr` link, the
   *  session owns the link and the task reads it
   *  (docs/plans/session-pull-requests.md). For a work, plan or automation,
   *  the session made the item (docs/plans/session-outputs.md). Such a link
   *  leaves the task when the session does. Absent on a link made on the task
   *  itself. */
  ownerSessionId?: string
  linkedAt: number
  /** The one `work` link a task page shows open by default. At most one link
   *  per task carries it; pinning another moves it. */
  pinned?: boolean
  /** A `pr` link whose pull request the code host says does not exist. */
  missing?: boolean
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
  category: TaskStatusCategory
  reference?: string
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
  /** Solus found this link by itself (a pull request a session is reviewing),
   *  so a later checkout may replace it. The host records who made every other
   *  link from the admitted request. */
  automatic?: boolean
  originSessionId?: string | null
  /** Pin this link, or unpin it. Omitted leaves the current pin alone, so a
   *  re-link that knows nothing about pinning cannot clear one. */
  pinned?: boolean
}

/** What a `task_changed` activity says Solus did to a task. Interleaved with
 *  `TaskComment[]` to build the feed. A change made on the provider has no
 *  activity here: the provider keeps that history. */
export type TaskEventKind =
  | 'created'
  | 'status_changed'
  | 'priority_changed'
  | 'assignee_changed'
  | 'due_date_changed'
  | 'title_changed'
  | 'labels_changed'
  | 'linked'
  | 'unlinked'
  | 'session_started'



/** A task with its comments and its Solus attachments, read from the provider
 * by the host that lists it. The detail read deliberately carries no session links. Attempts live in one
 * place — the renderer's `sessionsByTask`, fed by `taskSessions()` — because a
 * second copy on this object could only ever disagree with it, and the detail
 * surfaces that would render it are the ones that overwrite it. */
export interface TaskDetails {
  task: Task
  comments: TaskComment[]
  links: TaskLink[]
  /** The task's `task_changed` activity, newest last, capped at
   *  `TASK_ACTIVITY_LIMIT`. Merge with `comments` by time to build the feed. */
  activity: Activity[]
  /** The provider did not answer, so `task` and `comments` are the host's last copy. */
  fromCache?: boolean
}

/** What Solus holds about a task on one host: the answer of a host that has
 *  attachments of a task but does not read it from a provider, such as the
 *  organization's Solus API. */
export type TaskAttachments = Pick<TaskDetails, 'links' | 'activity'>

export interface TaskForSessionResult {
  task: Task
  attempts: TaskSessionLink[]
}

/**
 * What a client sends to a host to bind the task a session is about to start
 * under. A session never makes a task of its own, so the request always names
 * one.
 *
 * There is no `sessionId`: the session does not exist yet at first dispatch, and
 * the execution host — which may be a different machine entirely — issues it.
 * The link is written afterwards through `tasksLinkSession`.
 */
export interface PrepareSessionTaskRequest {
  /** The task the session joins. */
  taskId: string
  /** Also return a `TaskSnapshot` of the bound task. Set by a client about to
   *  dispatch to a different execution host, which needs the snapshot to ride
   *  the prompt (see docs/plans/dispatch-parity.md). */
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
 *  `read_work`/`read_plan`/`find_works` answer from these copies. PR and
 *  automation links ship no content: their facts (title, url, live status)
 *  already ride `TaskDetails.links`. */
interface LinkedItemSnapshotBase {
  /** The link's target key: a work id, or a plan's `planToolUseId`. */
  key: string
  /** The link's target scope: `''` for works; the plan's owning session id. */
  scope: string
  title: string
  content: string
  updatedAt?: string
}

export type TaskLinkedItemSnapshot =
  | (LinkedItemSnapshotBase & {
    kind: 'work'
    /** How the content renders. */
    workType: WorkType
    /** The `contentVersion` of `content`, the precondition an `update_work`
     *  from the dispatched session names. */
    contentVersion: number
  })
  | (LinkedItemSnapshotBase & { kind: 'plan' })

/**
 * The serializable task state a dispatched prompt carries: exactly what
 * `formatTaskContext` consumes, so the execution host renders the packet from
 * it verbatim and serves `read_task` from the same shape. Assembled on the
 * task's own host; never persisted on the execution host.
 */
export interface TaskSnapshot {
  details: TaskDetails
  sessions: TaskSessionLink[]
  /** Full content of the task's content-bearing linked items (works, plans),
   *  so the dispatched agent can read the documents its task points at.
   *  Absent on snapshots from older hosts. */
  linked?: TaskLinkedItemSnapshot[]
}

/** A task as a list shows it: every field of `Task` but the body and the epic,
 *  which only the detail read carries (plans/029 §8). */
export type TaskSummary = Omit<Task, 'body' | 'epic'>

/** One authoritative renderer snapshot of the tasks a host holds for the reader
 * and their session ownership, read together so the sidebar never has to
 * reconcile independently timed task and link responses. A host that holds
 * only attachments (the organization's Solus API) answers no tasks, and the
 * links of the task keys it knows. */
export interface TaskSidebarSnapshot {
  tasks: TaskSummary[]
  sessionsByTask: Record<string, TaskSessionLink[]>
  /** Every durable PR edge, newest first. The first entry is the newest link. */
  prLinkListsByTask?: Record<string, TaskSidebarPrLink[]>
  /** The state of the list this answer covers. A whole read and a resume give
   *  it; send it back as `since` to resume. Absent from older hosts. */
  revision?: string
  /** Present only on a resume: the tasks that changed after `since`. The answer
   *  holds the rows of those that remain; a named task it leaves out has gone.
   *  Empty when nothing changed (docs/plans/task-snapshot-resume.md). */
  changedTaskIds?: string[]
}

/** `tasksSearchComments`: the tasks whose comments hold every word of a query
 *  (docs/plans/unified-search.md §7). */
export interface TaskCommentSearchQuery {
  query: string
  /** One project; omit to search every project. */
  projectKey?: string
}

/** One task found by its comments, with the passage of the comment that matched. */
export interface TaskCommentHit {
  taskId: string
  commentId: string
  /** The comment's passage, each matched word between the markers of `search-snippet.ts`. */
  snippet: string
  createdAt: number
}

/** Narrows a sidebar snapshot to named tasks, so one changed task costs one
 *  row rather than the whole list. A named task absent from the answer was
 *  deleted or is no longer visible to the caller. */
export interface TaskSidebarFilter {
  taskIds?: string[]
  /** The `revision` of the last answer this client applied for the whole list.
   *  The host then names only the tasks changed after it, or sends the whole
   *  list when it cannot. Ignored with `taskIds`. */
  since?: string
}

/** The most task ids one narrowed sidebar read may name. A client with more
 *  changes waiting reads the whole list instead. */
export const MAX_SIDEBAR_TASK_IDS = 200

/** Why a task source cannot be read. `reconnect` means the connection exists
 *  but lacks a permission the source needs (the GitHub `project` scope, the
 *  Jira Software scopes). */
export type TaskSourceHealth = 'ok' | 'not_connected' | 'reconnect' | 'no_access' | 'error'

/** One task source of a project, as the host last read it for the reader. */
export interface TaskSourceState {
  sourceKey: string
  source: TaskSource
  /** The source as a person reads it: `acme/app`, a Project's title, `SOL`, a board's name. */
  label: string
  columns: TaskColumn[]
  health: TaskSourceHealth
  /** Why `health` is not `ok`, in words a person can read. */
  message?: string
  /** Epoch ms of the last read that the provider answered. Absent = never read. */
  fetchedAt?: number
  /** The source holds more tasks than the host read. Search reaches the rest. */
  truncated?: boolean
  /** The host reads the source now; `tasks.sourcesChanged` says when it ends. */
  refreshing?: boolean
}

/** What a person can choose as a task source: what their GitHub and Jira connections list. */
export interface TaskSourceOptions {
  github: {
    connected: boolean
    login?: string
    /** False when the connection cannot read Projects: connect GitHub again. */
    hasProjectScope?: boolean
    /** The repositories the person pushed to most recently. */
    repositories: Array<{ owner: string; repo: string }>
    projects: Array<{ owner: string; number: number; title: string }>
  }
  jira: {
    connected: boolean
    cloudId?: string
    siteUrl?: string
    projects: Array<{ projectKey: string; name: string }>
    boards: Array<{ boardId: number; name: string; projectKey?: string }>
    /** Why the boards could not be listed, such as a missing Jira Software scope. */
    boardsError?: string
  }
}

/** Stable marker prepended to auth/connection failures from a task provider,
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
 *  the user can jump from a task to the work happening on it. An attachment:
 *  Solus stores it by task key and never writes it to the provider. */
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
  /** The provider thread the indexed record belongs to, when it differs from
   *  `sessionId`. An agent's task comment names this id, not the stable one. */
  agentSessionId?: string
  /** Agent that ran the session, as the session index stores it. Null for a
   *  link whose session is not indexed yet. */
  provider: AgentId | null
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
  /** Checkout address on executionServerId (or the task host), when indexed. */
  checkoutPath?: string
  /** Whether that branch is the session's own worktree rather than a clone it
   *  shares. Git state is held per working directory, so every attempt running
   *  in one checkout reports the same branch — a fact about the checkout, not
   *  about the session. Only an isolated one may claim a pull request.
   *  Undefined where the session is not indexed yet, which claims nothing. */
  isolatedCheckout?: boolean
  /** Epoch ms the link was recorded; drives "most recent session" ordering. */
  linkedAt: number
  /** Who started the session. Absent when nobody recorded it. */
  startedBy?: Attribution
}
