import { parseGitHubPullRequestUrl, type PullRequest } from '@solus/contracts/providers'
import type { Session } from '@solus/contracts/types'
import type { Task } from '@solus/contracts/task-types'
import type { AttentionState } from '../../../lib/sessionUtils'

/** The sidebar's state vocabulary. Narrower than `AttentionState`: the column
 *  reports what a task wants from a person, so "finished but unread" is not a
 *  separate task status here — session attention carries it, and the margin
 *  reports it with a dot rather than another glyph.
 *
 *  `done` is the one status the user sets rather than the agent: it is what the
 *  check in the hover cluster writes, and it only says "I am finished with
 *  this", which nothing else in the app knows. */
export type TaskStatus = 'question' | 'error' | 'plan' | 'limit' | 'running' | 'idle' | 'done'

/** One fixed order everywhere. The list is a queue of decisions, so anything
 *  that stopped and asked sorts above anything still working. */
export const STATUS_RANK = {
  question: 0,
  error: 1,
  plan: 2,
  limit: 3,
  running: 4,
  idle: 5,
  done: 6,
} satisfies Record<TaskStatus, number>

export const ATTENTION_RANK = {
  awaiting: 5,
  awaiting_plan: 5,
  queued: 4,
  error: 3,
  running: 2,
  unread: 1,
} satisfies Record<NonNullable<AttentionState>, number>

/** A task reports work and requests shared by its sessions, but a failed turn
 * stays on its own session row. One failed attempt must not make the durable
 * task itself look failed. */
export function maxTaskAttention(current: AttentionState, next: AttentionState): AttentionState {
  if (next === 'error') return current
  if (!next) return current
  if (!current) return next
  return ATTENTION_RANK[next] > ATTENTION_RANK[current] ? next : current
}

/** Statuses that earn a glyph. Running reports elapsed time instead; idle and
 *  done report nothing at all. */
export function hasGlyph(status: TaskStatus): boolean {
  return status !== 'running' && status !== 'idle' && status !== 'done'
}

/** Error remains visible in the margin after it is read, but only an unread
 * error uses title weight to call for attention. Selection still emphasizes
 * every other state; the accent spine is enough to locate a read error. */
export function shouldEmphasizeTitle(
  status: TaskStatus,
  unread: boolean,
  isCurrent: boolean,
): boolean {
  if (status === 'error') return unread
  return isCurrent || hasGlyph(status)
}

/**
 * Full ink, which is a *separate axis from weight*. Weight stays reserved for
 * the row being read and the rows blocked on a person — one meaning per row —
 * so unread deliberately does not bold a title. But mutedness is how the column
 * ranks rows now, and a row nobody has read is not something to rank down: the
 * margin dot was calibrated against titles that all sat at full ink, and it
 * cannot carry unread alone once its row recedes. So unread climbs back out of
 * the mutedness and stops there.
 *
 * A read error is the one state that leads in neither: its glyph is durable
 * status the margin keeps stating, and lifting the row again after the user has
 * already looked at it would make the column impossible to clear.
 */
export function shouldLeadTitle(
  status: TaskStatus,
  unread: boolean,
  isCurrent: boolean,
): boolean {
  if (status === 'error') return unread
  return unread || shouldEmphasizeTitle(status, unread, isCurrent)
}

/** Session output stays unread independently of the durable task lifecycle.
 * A state that needs the user keeps its more specific glyph; otherwise the
 * unread dot wins over idle, running, or done presentation. */
export function showsUnreadIndicator(status: TaskStatus, unread: boolean): boolean {
  return unread && !hasGlyph(status)
}

/**
 * Whether a task row opens onto anything. Several sessions obviously do; so does
 * a single one that belongs to a *subtask*, because the row above it is named
 * after the root task and would otherwise be the only trace of the child's
 * existence. A lone session of the task itself discloses nothing — the row is
 * already that session.
 */
export function hasDisclosure(sessions: readonly { isSubtask?: boolean }[]): boolean {
  return sessions.length > 1 || sessions.some((session) => session.isSubtask)
}

/**
 * The branch or worktree a task row can state as its own. A durable task row
 * carries no branch, so the answer belongs to its lone session — whose row is
 * never on screen, because a task with one plain session discloses nothing. A
 * task that discloses leaves the question to its children, which can each
 * answer it differently.
 */
export function taskRowBranchName(
  taskBranchName: string | null,
  sessions: readonly { branchName: string | null; isSubtask?: boolean }[],
): string | null {
  if (hasDisclosure(sessions)) return null
  return sessions.length === 1 ? (sessions[0].branchName ?? taskBranchName) : taskBranchName
}

/** A child-task row represents the durable subtask, not the provider session
 * executing it. Root-task attempts remain session-named so multiple attempts
 * are distinguishable — `sessionName` is the shared `sessionDisplayName`, which
 * has already resolved the live tab, the indexed title and the task fallback. */
export function sidebarChildLabel(
  task: Pick<Task, 'parentId' | 'title'>,
  sessionName: string,
): string {
  return task.parentId ? task.title : sessionName
}

export type ReviewGuideIndicatorStatus = 'generating' | 'ready' | null

/** A task summarizes every session below it. Work in flight wins over ready so
 * the parent never looks settled while one of its guides is still being made. */
export function aggregateReviewGuideStatus(
  sessions: readonly { reviewGuideStatus: ReviewGuideIndicatorStatus }[],
): ReviewGuideIndicatorStatus {
  if (sessions.some((session) => session.reviewGuideStatus === 'generating')) return 'generating'
  return sessions.some((session) => session.reviewGuideStatus === 'ready') ? 'ready' : null
}

/**
 * `markedDone` is the user's own verdict and only survives while the task is at
 * rest — the moment it wants something or starts working again, the agent's
 * state is the truth and the check the user ticked is stale.
 */
export function taskStatusFor(attention: AttentionState, markedDone = false): TaskStatus {
  switch (attention) {
    case 'awaiting':
      return 'question'
    case 'error':
      return 'error'
    case 'awaiting_plan':
      return 'plan'
    case 'queued':
      return 'limit'
    case 'running':
      return 'running'
    default:
      return markedDone ? 'done' : 'idle'
  }
}

/**
 * The elapsed readout on a running row. Tabular figures keep the digits from
 * shifting, but only zero-padding keeps the *string* the same width — without
 * it the row jumps every time the clock crosses `9s` into `10s`, which is the
 * one thing a column that sits in peripheral vision all day must not do.
 *
 * Seconds are spent only in the first minute. Past that the row is answering
 * "is this still going, and roughly how long" — a question `12m` answers as
 * well as `12m 07s` does, in four fewer characters of a column that has none
 * to spare. The hour form keeps its minutes because the jump from `1h` to `2h`
 * is otherwise an hour wide.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`

  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}

/**
 * When a snoozed row comes back, as a duration rather than a clock time. The
 * row's whole story is the return ticket, and a sidebar that reports every
 * other time as an elapsed duration must not report this one as `Thu 3:00 PM`:
 * two scales in one column means neither can be read at a glance.
 *
 * Rounds up, so a snooze still in force never reads `0m` while the row is
 * demonstrably still hidden.
 */
export function formatWakeIn(snoozedUntil: number, now: number): string {
  const remaining = snoozedUntil - now
  if (remaining <= 0) return 'now'
  if (remaining < 3_600_000) return `${Math.max(1, Math.ceil(remaining / 60_000))}m`
  if (remaining < 86_400_000) return `${Math.ceil(remaining / 3_600_000)}h`
  return `${Math.ceil(remaining / 86_400_000)}d`
}

/** Compact age for the completed shelf. The shelf answers only how long ago
 * the task ended, so it keeps the unit stable instead of switching to a date. */
export function formatCompletedAge(completedAt: number, now: number): string {
  if (!completedAt) return ''
  const elapsed = Math.max(0, now - completedAt)
  if (elapsed < 60_000) return 'now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return `${Math.floor(elapsed / 86_400_000)}d`
}

/** The single thing a row's trailing slot says. */
export type SidebarRowMark =
  | { kind: 'glyph'; status: TaskStatus }
  | { kind: 'woke' }
  | { kind: 'unread' }
  | { kind: 'guide'; state: 'ready' | 'generating' }
  | { kind: 'elapsed'; label: string }
  | { kind: 'spinner' }
  | { kind: 'wake'; label: string }
  | { kind: 'age'; label: string }

export interface SidebarRowMarkInput {
  status: TaskStatus
  unread: boolean
  /** The last snooze expired after this row was last visited. */
  woke: boolean
  reviewGuide: ReviewGuideIndicatorStatus
  lifecycle: SidebarTask['lifecycle']
  /** Start of the turn in flight. 0 unless running. */
  runStartedAt: number
  /** Several sessions are running at once, so no single turn can be dated. */
  manyRunning: boolean
  completedAt: number
  snoozedUntil: number
  now: number
}

/**
 * The one mark a row spends, resolved from every state the row is in.
 *
 * The slot is single-valued on purpose. It used to be a cluster: a review-guide
 * glyph, an alarm, a wake time and a clock could all land in the same right
 * edge at once, so four marks competed for one glance and the row answered no
 * question quickly. Ranking them here means the row states its loudest fact and
 * nothing else — the rest stays in the row's tooltip and context menu, which is
 * where a second-order fact belongs.
 *
 * The order is the column's existing one: anything that stopped and asked for a
 * person first, then anything holding output nobody has read, then reports of
 * progress, then the two shelves' own clocks. It matches `STATUS_RANK`, so a
 * row's mark and its position in the pickers can never disagree.
 */
export function resolveSidebarRowMark(input: SidebarRowMarkInput): SidebarRowMark | null {
  if (hasGlyph(input.status)) return { kind: 'glyph', status: input.status }
  // A lapsed snooze is a promise the column made to the user, so it outranks
  // unread output the user has never been told to expect.
  if (input.woke) return { kind: 'woke' }
  if (showsUnreadIndicator(input.status, input.unread)) return { kind: 'unread' }
  if (input.reviewGuide === 'ready') return { kind: 'guide', state: 'ready' }
  if (input.status === 'running') {
    // A number can only date one turn. Once several sessions run at once there
    // is no single clock to report, so the row says *that* work is in flight
    // and leaves the durations to the session rows that own them. A reconnect
    // with no reliable start time takes the same fallback: show motion rather
    // than leave a running row blank.
    return input.runStartedAt && !input.manyRunning
      ? { kind: 'elapsed', label: formatElapsed(input.now - input.runStartedAt) }
      : { kind: 'spinner' }
  }
  // Writing a guide is work in flight too, but it is quieter than a live turn
  // and never competes with one.
  if (input.reviewGuide === 'generating') return { kind: 'guide', state: 'generating' }
  if (input.lifecycle === 'snoozed') {
    return { kind: 'wake', label: formatWakeIn(input.snoozedUntil, input.now) }
  }
  if (input.lifecycle === 'completed') {
    const label = formatCompletedAge(input.completedAt, input.now)
    return label ? { kind: 'age', label } : null
  }
  return null
}

/**
 * Whether the whole row steps back.
 *
 * The column used to tune each element's tone separately — title at one mix,
 * clock at another, project line at a third — which kept every row legible and
 * therefore kept every row competing. Recession is a property of the *row*
 * instead: quiet work drops to the secondary ink as one object and its trailing
 * mark keeps its own colour, so a full column reads as mostly grey with a few
 * saturated marks in it, and the eye lands on the rows that did not recede.
 *
 * Nothing that wants a person recedes: a row asking a question, holding unread
 * output, returning from a snooze, or sitting on the path you are reading stays
 * at full ink however quiet the rest of the column is.
 */
export function shouldRecedeRow(
  status: TaskStatus,
  unread: boolean,
  woke: boolean,
  isOnPath: boolean,
): boolean {
  return !hasGlyph(status) && !unread && !woke && !isOnPath
}

export interface SidebarTask {
  /** Stable renderer identity for this task or loose session row. */
  id: string
  /** Durable task id when this row is backed by the task store. Loose session
   *  rows deliberately leave it unset until the first dispatch mints a task. */
  taskId?: string
  /** Navigation key. Durable task rows use their task id. */
  key: string
  title: string
  projectKey: string
  projectLabel: string
  /** Real git branch, matched against a PR's head ref. Null off a branch. */
  branchName: string | null
  /** The host this task's sessions run on. Null when nothing is open for it —
   *  the task record itself does not remember a machine. */
  serverId: string | null
  /** The PR number the task record captured, for when the live PR list can't
   *  answer (another project's PRs, or a PR that has already been merged out of
   *  the list). 0 and null both mean "none". */
  prNumber: number | null
  status: TaskStatus
  /** The raw state behind `status`, kept so glyphs can be labelled in the
   *  app's own words rather than the sidebar's narrower vocabulary. */
  attention: AttentionState
  /** True while any mounted session has output the user has not seen. The
   *  active session clears its own flag, so task activity must not set this. */
  unread: boolean
  /** Durable creation position shared by task-backed and legacy loose rows. */
  createdAt: number
  /** Sort tie-break: most recent activity first. */
  activityAt: number
  /** Start of the turn in flight, for the elapsed readout. 0 unless running. */
  runStartedAt: number
  lifecycle: 'active' | 'snoozed' | 'completed'
  completedAt: number
  snoozedUntil: number
  snoozeNote: string | null
  lastReadAt: number
  /** The last snooze expired after this task was last visited. */
  woke: boolean
  tabIds: string[]
}

/** Search the task column without changing its learned order. Project names
 *  are included because the unscoped sidebar can show several projects whose
 *  tasks use similar titles. An empty query returns the original array so the
 *  mounted row graph keeps its identity when search is not in use. */
export function filterSidebarTasks(
  tasks: SidebarTask[],
  query: string,
): SidebarTask[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return tasks
  return tasks.filter((task) =>
    `${task.title} ${task.projectLabel}`.toLocaleLowerCase().includes(needle),
  )
}

/** A submitted prompt wakes the row that owns its mounted session. Check the
 * wake time rather than the derived shelf: a question can temporarily lift a
 * snoozed row into Active while its snooze is still in force. */
export function snoozedRowKeyForTab(
  tasks: SidebarTask[],
  tabId: string,
  now = Date.now(),
): string | null {
  return tasks.find(
    (task) => task.snoozedUntil > now && task.tabIds.includes(tabId),
  )?.key ?? null
}

/** A snooze defers progress, not a request. A run that stopped to ask
 *  something — a permission, a plan, an error it cannot pass — is the strongest
 *  call for a person there is, so it outranks the snooze and returns the row to
 *  the active list. `running` is deliberately absent: quiet progress is exactly
 *  what the user chose to hide, and a snoozed task keeps working. */
function outranksSnooze(attention: AttentionState): boolean {
  return attention === 'awaiting' || attention === 'awaiting_plan' || attention === 'error'
}

/**
 * Which shelf a row sits on. Every input is a plain value rather than a task,
 * because a row need not have one: the workflow status and completion time come
 * from a task when there is one, and the wake time is always the sidebar's own.
 */
export function resolveTaskSidebarLifecycle(input: {
  status: Task['status']
  doneAt?: number
  /** Fallback completion time. A task finished before the store recorded
   *  `doneAt` has no other date, and a completed row with no date at all sorts
   *  to the bottom of the shelf and reports no age — so the record's last
   *  change stands in for the moment it ended. */
  updatedAt?: number
  /** The sidebar's wake time for this row. Absent when it is not snoozed. */
  snoozedUntil?: number
  lastReadAt?: number
  /** Live session state. Absent for a row with no session on this client, in
   *  which case nothing can outrank the snooze. */
  attention?: AttentionState
  now: number
}): Pick<SidebarTask, 'lifecycle' | 'completedAt' | 'snoozedUntil' | 'lastReadAt' | 'woke'> {
  const snoozedUntil = input.snoozedUntil ?? 0
  const lastReadAt = input.lastReadAt ?? 0
  // Both explicit workflow endings shelve the row. Sidebar dismissal is separate
  // view state and never writes either status.
  const isCompleted = input.status === 'done' || input.status === 'dropped'
  // Derived, never written: the snooze survives the interruption, so answering
  // the question leaves the original wake time in force.
  const isSnoozed = !isCompleted
    && snoozedUntil > input.now
    && !outranksSnooze(input.attention ?? null)
  return {
    lifecycle: isCompleted ? 'completed' : isSnoozed ? 'snoozed' : 'active',
    completedAt: isCompleted ? input.doneAt || input.updatedAt || 0 : input.doneAt ?? 0,
    snoozedUntil,
    lastReadAt,
    woke: snoozedUntil > 0 && snoozedUntil <= input.now && lastReadAt < snoozedUntil,
  }
}

/** A linked PR ending is authoritative completion for its task. */
export function shouldCompleteTaskForPr(
  task: Pick<Task, 'status' | 'updatedAt'>,
  pr: Pick<PullRequest, 'state' | 'updatedAt'>,
): boolean {
  if (task.status === 'done' || (pr.state !== 'closed' && pr.state !== 'merged')) return false
  const prUpdatedAt = Date.parse(pr.updatedAt)
  // A task changed after the PR reached its terminal state has been explicitly
  // reopened (or otherwise resumed). That newer task decision wins until the PR
  // itself changes state again; merely reloading the sidebar must not re-close it.
  return !Number.isFinite(prUpdatedAt) || task.updatedAt <= prUpdatedAt
}

/** A task appears only after this client opens it. Child tasks render under
 * their root, and a local dismissal keeps a root closed until a session reopens
 * it. Task status does not add a row by itself. */
export function shouldShowDurableSidebarTask(
  task: Task,
  isDismissed: boolean,
  hasOpenSession: boolean,
  isOpenOnClient: boolean,
): boolean {
  return !task.parentId && (hasOpenSession || (!isDismissed && isOpenOnClient))
}

/** A session whose task is done is finished work, whatever its tab is doing.
 * The sidebar keeps that row behind the Completed shelf, so the picker must not
 * offer the same session under "Open" beside sessions still being worked on.
 * A snoozed task is deliberately deferred, not finished, and keeps its place. */
export function isCompletedTaskSession(
  session: Pick<Session, 'id' | 'agentSessionId' | 'handoffId'>,
  tasks: TaskBySessionLookup,
): boolean {
  const task = tasks.taskForSession(session.handoffId ?? session.id)
    ?? tasks.taskForSession(session.agentSessionId)
  return task?.status === 'done'
}

/**
 * Whether finished work earns a Completed row the active column never gave it.
 *
 * The column is a working set — a row is there because this client has the task
 * open — and that rule is right for work in flight and exactly wrong for work
 * that ended. A task the user finished and put away is the one they go looking
 * for later, so the shelf asks the task store instead and lets retention decide
 * how long it stays. Both explicit workflow endings count.
 */
export function shouldShelveCompletedTask(
  task: Pick<Task, 'parentId' | 'status'>,
  isAlreadyInColumn: boolean,
): boolean {
  if (task.parentId || isAlreadyInColumn) return false
  return task.status === 'done' || task.status === 'dropped'
}

/** The task store's answer for one session, narrowed to what this rule reads. */
export interface TaskBySessionLookup {
  taskForSession(sessionId: string | null | undefined): Task | null
}

/** Same rule one level down: a dismissed child returns with a reopened tab. */
export function shouldShowSidebarChild(isDismissed: boolean, hasOpenTab: boolean): boolean {
  return !isDismissed || hasOpenTab
}

/**
 * Preserve row model identity when a sidebar recomputation produced the same
 * task data. Selection clears one tab's unread flag; without structural
 * sharing that tiny update hands every keyed row a fresh object and makes the
 * whole column update.
 */
export function reconcileSidebarTasks(
  previousById: Map<string, SidebarTask>,
  nextTasks: SidebarTask[],
): SidebarTask[] {
  const liveIds = new Set<string>()
  const reconciled = nextTasks.map((next) => {
    liveIds.add(next.id)
    const previous = previousById.get(next.id)
    if (
      previous &&
      previous.taskId === next.taskId &&
      previous.key === next.key &&
      previous.title === next.title &&
      previous.projectKey === next.projectKey &&
      previous.projectLabel === next.projectLabel &&
      previous.branchName === next.branchName &&
      previous.serverId === next.serverId &&
      previous.prNumber === next.prNumber &&
      previous.status === next.status &&
      previous.attention === next.attention &&
      previous.unread === next.unread &&
      previous.createdAt === next.createdAt &&
      previous.activityAt === next.activityAt &&
      previous.runStartedAt === next.runStartedAt &&
      previous.lifecycle === next.lifecycle &&
      previous.completedAt === next.completedAt &&
      previous.snoozedUntil === next.snoozedUntil &&
      previous.snoozeNote === next.snoozeNote &&
      previous.lastReadAt === next.lastReadAt &&
      previous.woke === next.woke &&
      previous.tabIds.length === next.tabIds.length &&
      previous.tabIds.every((tabId, index) => tabId === next.tabIds[index])
    ) {
      return previous
    }
    previousById.set(next.id, next)
    return next
  })

  for (const id of previousById.keys()) {
    if (!liveIds.has(id)) previousById.delete(id)
  }
  return reconciled
}

/** Oldest first. `shortId` is allocated monotonically, so it preserves the
 * creation order of records written in the same millisecond. A ULID's random
 * suffix is only a deterministic final fallback, not a creation sequence. */
export function compareTaskCreationOrder(a: Task, b: Task): number {
  const created = (a.createdAt ?? 0) - (b.createdAt ?? 0)
  if (created !== 0) return created
  if (a.shortId !== undefined && b.shortId !== undefined) {
    return a.shortId - b.shortId
  }
  return a.id.localeCompare(b.id)
}

/** The sidebar's durable order. Copy before sorting so a renderer projection
 * never mutates the task store that every other mounted surface shares. */
export function sortTasksByCreation(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(compareTaskCreationOrder)
}

/** Keep sidebar rows in their fixed creation order. Session tabs can open,
 * close, merge under one task, or be dragged independently without moving the
 * task row the user already learned. */
export function sortSidebarRowsByCreation(tasks: SidebarTask[]): SidebarTask[] {
  return [...tasks].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** Rank, then most recent activity, then the order the tasks were created in
 *  — which is the order they arrive in. */
function compareTasks(a: SidebarTask, b: SidebarTask): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
  if (rank !== 0) return rank
  return b.activityAt - a.activityAt
}

/**
 * Rank tasks by urgency. This is for the *pickers*, which are read top-down in
 * one glance and gain from putting the loudest task first. The sidebar list
 * itself never sorts: a row you learned the position of has to still be there
 * the next time you look, so open tasks keep the order they arrived in and
 * status is carried by the glyph alone.
 */
export function sortTasks(tasks: SidebarTask[]): SidebarTask[] {
  return [...tasks].sort(compareTasks)
}

export interface TaskGroup {
  projectKey: string
  projectLabel: string
  tasks: SidebarTask[]
}

/** Groups keep their tasks in the order they were given, and sit in alphabetical
 *  order themselves — a project that starts working must not haul its whole
 *  section up the column. */
export function groupTasks(tasks: SidebarTask[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>()
  for (const task of tasks) {
    let group = groups.get(task.projectKey)
    if (!group) {
      group = {
        projectKey: task.projectKey,
        projectLabel: task.projectLabel,
        tasks: [],
      }
      groups.set(task.projectKey, group)
    }
    group.tasks.push(task)
  }

  return [...groups.values()].sort((a, b) => a.projectLabel.localeCompare(b.projectLabel))
}

export interface ProjectSummary {
  projectKey: string
  label: string
  count: number
  /** Tasks in this project that stopped and asked, and tasks whose run died.
   *  The picker names them in the same words the list uses. */
  waiting: number
  failed: number
  /** The task to land on when this project is picked — its most urgent one. */
  leadTaskKey: string
}

/**
 * The projects behind the breadcrumb's picker.
 */
export function buildProjectSummaries(allTasks: SidebarTask[]): ProjectSummary[] {
  const byProject = new Map<string, SidebarTask[]>()
  for (const task of allTasks) {
    const tasks = byProject.get(task.projectKey)
    if (tasks) tasks.push(task)
    else byProject.set(task.projectKey, [task])
  }

  return [...byProject.entries()].map(([projectKey, tasks]) => {
    const ranked = sortTasks(tasks)
    return {
      projectKey,
      label: tasks[0].projectLabel,
      count: tasks.length,
      waiting: tasks.filter((task) => task.status === 'question' || task.status === 'plan').length,
      failed: tasks.filter((task) => task.status === 'error').length,
      leadTaskKey: ranked[0].key,
    }
  })
}

/**
 * The scope actually in force. A saved filter outlives the project it names, so
 * a project that has left the column entirely must not keep scoping it — the
 * list would be empty and the only way out would be a project the user can no
 * longer pick. A project still holding snoozed or completed work has not left:
 * its list is legitimately empty, and saying so is the whole point of the
 * empty line.
 */
export function resolveProjectFilter(
  savedFilter: string | null,
  allTasks: readonly SidebarTask[],
): string | null {
  if (!savedFilter) return null
  return allTasks.some((task) => task.projectKey === savedFilter) ? savedFilter : null
}

export interface ProjectFilterChoice {
  projectKey: string
  label: string
  /** Active tasks only, so the figure beside a project agrees with the list the
   *  filter produces. Snoozed and completed live on their own shelves. */
  count: number
}

/** The filter menu's projects, in the order their tasks already sit in the
 *  column, so picking one never reorders what you were reading. Every project
 *  the column knows about is offered, including one whose work has all been
 *  snoozed or completed — it is still a scope, and it still reads 0. */
export function projectFilterChoices(allTasks: readonly SidebarTask[]): ProjectFilterChoice[] {
  const choices = new Map<string, ProjectFilterChoice>()
  for (const task of allTasks) {
    const active = task.lifecycle === 'active' ? 1 : 0
    const existing = choices.get(task.projectKey)
    if (existing) existing.count += active
    else
      choices.set(task.projectKey, {
        projectKey: task.projectKey,
        label: task.projectLabel,
        count: active,
      })
  }
  return [...choices.values()]
}

export type PrChipState = 'draft' | 'open' | 'approvalRequested' | 'closed' | 'merged'

export interface PrChip {
  number: number
  count: number
  state: PrChipState
}

/**
 * One pull request a row's chip stands for.
 *
 * Identity — the number, the project it belongs to, and the page it is on —
 * comes from whatever named it: a durable task link, or the branch the session's
 * checkout is on. `pullRequest` is the live record when this client holds one,
 * and null when it does not: a host that is unreachable, unauthenticated, or
 * simply not asked yet leaves the identity intact, so the row still shows the
 * pull request and can still open it. Nothing here is reconstructed — a missing
 * URL stays missing rather than being assembled from a repository and a number.
 */
export interface TaskPrChoice {
  number: number
  targetScope: string
  title: string
  url: string | null
  pullRequest: PullRequest | null
}

/** The set a task's chip is built from: every pull request linked to it, plus
 *  every one its sessions' branches point at, each named once.
 *
 * Deduplicated on repository identity where a URL says which repository is
 * meant, and on the owning project otherwise — the same pull request reached
 * through a link and through a branch is one entry, and the same number in two
 * repositories is two. The first mention wins, so a link's own title survives a
 * branch observation of the same pull request. */
export function dedupePrChoices(choices: readonly TaskPrChoice[]): TaskPrChoice[] {
  const found: TaskPrChoice[] = []
  const byKey = new Map<string, TaskPrChoice>()
  for (const choice of choices) {
    const parsedUrl = choice.url ? parseGitHubPullRequestUrl(choice.url) : null
    // Both names for one pull request. A mention that carries a URL is known by
    // its repository, and every mention is known by the project it was found
    // in — so a link with no URL and a branch observation with one still meet,
    // which is the ordinary case: the durable link is a number, and the
    // checkout reports a page.
    const keys = [`${choice.targetScope}#${choice.number}`]
    if (parsedUrl) {
      keys.unshift(
        `${parsedUrl.baseRepo.host}/${parsedUrl.baseRepo.owner}/${parsedUrl.baseRepo.repo}#${parsedUrl.number}`,
      )
    }
    const existing = keys.map((key) => byKey.get(key)).find(Boolean)
    if (!existing) {
      found.push(choice)
      for (const key of keys) byKey.set(key, choice)
      continue
    }
    // Take what either mention knows: the live record from whichever carried
    // one, and a URL from whichever had one. Neither is more authoritative
    // about the other's field, and the first mention keeps its title.
    if (!existing.pullRequest && choice.pullRequest) existing.pullRequest = choice.pullRequest
    if (!existing.url && choice.url) existing.url = choice.url
    for (const key of keys) if (!byKey.has(key)) byKey.set(key, existing)
  }
  return found
}

export interface MountedPrObservation {
  sessionIds: readonly string[]
  originSessionId: string
  /** Undefined Git status is still loading. Null is a completed “no PR” answer. */
  prUrl: string | null | undefined
  /** The observed checkout is this session's own worktree. Git state is keyed
   *  by working directory, so every tab open on one clone reports the same
   *  pull request; only an isolated checkout may record what it sees. */
  isolatedCheckout: boolean
}

export function samePullRequest(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  const parsedLeft = parseGitHubPullRequestUrl(left)
  const parsedRight = parseGitHubPullRequestUrl(right)
  return !!parsedLeft && !!parsedRight
    && parsedLeft.baseRepo.host === parsedRight.baseRepo.host
    && parsedLeft.baseRepo.owner === parsedRight.baseRepo.owner
    && parsedLeft.baseRepo.repo === parsedRight.baseRepo.repo
    && parsedLeft.number === parsedRight.number
}

export function prChipState(pr: PullRequest): PrChipState {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.draft) return 'draft'
  if (pr.needsMyReview) return 'approvalRequested'
  return 'open'
}

/** The token represents the whole linked set. Attention leads, then active
 * work; only an entirely merged set reads as merged.
 *
 * A choice this client holds no record for reads as open. It is a pull request
 * somebody linked or pushed a branch for, and open is what one is until a host
 * says otherwise — the alternative, hiding it, is how a disconnected host used
 * to empty the column of pull requests that plainly exist. */
export function prChipForChoices(choices: readonly TaskPrChoice[]): PrChip | null {
  const first = choices[0]
  if (!first) return null
  const states = choices.map((choice) => (choice.pullRequest ? prChipState(choice.pullRequest) : 'open'))
  const state = states.includes('approvalRequested')
    ? 'approvalRequested'
    : states.includes('open')
      ? 'open'
      : states.includes('draft')
        ? 'draft'
        : states.every((candidate) => candidate === 'merged')
          ? 'merged'
          : 'closed'
  return { number: first.number, count: choices.length, state }
}

export function pullRequestForBranches(
  branchNames: readonly (string | null)[],
  prs: readonly PullRequest[],
  recordedNumber: number | null = null,
): PullRequest | undefined {
  if (recordedNumber) return prs.find((item) => item.number === recordedNumber)
  for (const branchName of branchNames) {
    if (!branchName) continue
    const pr = prs.find((item) => item.headRef === branchName)
    if (pr) return pr
  }
  return undefined
}

/**
 * A PR linked to the task is authoritative. Use the live list only to enrich
 * that linked number with its current state. Without a link, match the branch
 * to the live list as a discovery fallback.
 *
 * `PullRequest` carries no human verdict, so "approved" and "changes
 * requested" are not distinguishable here and render as plain open.
 */
export function prChipFor(
  branchName: string | null,
  prs: readonly PullRequest[],
  recordedNumber: number | null = null,
): PrChip | null {
  const pr = recordedNumber
    ? prs.find((item) => item.number === recordedNumber)
    : branchName
      ? prs.find((item) => item.headRef === branchName)
      : undefined
  if (!pr) return null
  return { number: pr.number, count: 1, state: prChipState(pr) }
}

/** A linked PR wins regardless of which attempt produced it. Without a link, a
 * task can still discover a PR from a remote worktree branch resolved after the
 * task itself was created. */
export function prChipForBranches(
  branchNames: readonly (string | null)[],
  prs: readonly PullRequest[],
  recordedNumber: number | null = null,
): PrChip | null {
  const pr = pullRequestForBranches(branchNames, prs, recordedNumber)
  return prChipFor(pr?.headRef ?? null, pr ? [pr] : [], recordedNumber)
}
