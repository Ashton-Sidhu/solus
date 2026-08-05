import type { PullRequestSummary } from '../../../../shared/providers'
import type { Task } from '../../../../shared/task-types'
import type { AttentionState } from '../../../lib/sessionUtils'

/** The sidebar's state vocabulary. Narrower than `AttentionState`: the column
 *  reports what a task wants from a person, so "finished but unread" is not a
 *  status here — it is an idle task carrying `SidebarTask.unread`, which the
 *  margin reports with a dot rather than a glyph.
 *
 *  `done` is the one status the user sets rather than the agent: it is what the
 *  check in the hover cluster writes, and it only says "I am finished with
 *  this", which nothing else in the app knows. */
export type TaskStatus = 'question' | 'error' | 'plan' | 'limit' | 'running' | 'idle' | 'done'

/** One fixed order everywhere. The list is a queue of decisions, so anything
 *  that stopped and asked sorts above anything still working. */
export const STATUS_RANK: Record<TaskStatus, number> = {
  question: 0,
  error: 1,
  plan: 2,
  limit: 3,
  running: 4,
  idle: 5,
  done: 6,
}

/** Statuses that earn a glyph. Running reports elapsed time instead; idle and
 *  done report nothing at all. */
export function hasGlyph(status: TaskStatus): boolean {
  return status !== 'running' && status !== 'idle' && status !== 'done'
}

/** Unread output outranks work in flight in the task margin. Once the user
 * clears it, the still-running task falls back to its live indicator. States
 * that are explicitly waiting on the user remain more urgent than unread. */
export function showsUnreadIndicator(status: TaskStatus, unread: boolean): boolean {
  return unread && (status === 'idle' || status === 'running')
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
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`

  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}

export interface SidebarTask {
  /** Stable renderer identity. Unlike the branch key, this survives worktree
   *  resolution and closing any one session within the task. */
  id: string
  /** Durable task id when this row is backed by the task store. Loose session
   *  rows deliberately leave it unset until the first dispatch mints a task. */
  taskId?: string
  /** Current branch key. This is navigation data and may change while a
   *  pending worktree resolves. */
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
  /** True while a session has output the user has not seen. Earns a dot in the
   *  margin ahead of idle or running state; clearing it reveals a run still in
   *  flight. States waiting on the user remain more urgent. */
  unread: boolean
  /** Durable creation position shared by task-backed and legacy loose rows. */
  createdAt: number
  /** Sort tie-break: most recent activity first. */
  activityAt: number
  /** Start of the turn in flight, for the elapsed readout. 0 unless running. */
  runStartedAt: number
  tabIds: string[]
}

/** Only child tasks (which render under their root) and an explicit sidebar
 * dismissal keep a row out. Open work restores an ordinary dismissal, but a
 * completed task stays dismissed even while its separate session keeps running. */
export function shouldShowDurableSidebarTask(
  task: Task,
  isDismissed: boolean,
  hasOpenSession: boolean,
): boolean {
  return !task.parentId && (!isDismissed || (hasOpenSession && task.status !== 'done'))
}

/** A dismissed child normally returns with an explicitly reopened tab. A child
 * dismissed by completion stays out while that already-running tab continues. */
export function shouldShowSidebarChild(
  isDismissed: boolean,
  hasOpenTab: boolean,
  isCompleted = false,
): boolean {
  return !isDismissed || (hasOpenTab && !isCompleted)
}

/** Resolve the breadcrumb's task without putting a local-only draft into the
 * sidebar projection. A draft can inherit a durable task before it has a
 * linked session or visible tab row of its own. */
export function activeSidebarTask(
  tasks: SidebarTask[],
  activeTabId: string,
  draftTabId: string | null,
  draftRootTaskId: string | null,
): SidebarTask | null {
  const openTask = tasks.find((task) => task.tabIds.includes(activeTabId))
  if (openTask || activeTabId !== draftTabId || !draftRootTaskId) return openTask ?? null
  return tasks.find((task) => task.taskId === draftRootTaskId) ?? null
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

/** Rebuild the sidebar from the persisted session order without privileging
 * task-backed rows over loose sessions. A task with several sessions occupies
 * the position of its first tab; durable rows with no open tab follow the open
 * sessions in their creation order. */
export function sortSidebarRowsBySessionOrder(
  tasks: SidebarTask[],
  tabOrder: readonly string[],
): SidebarTask[] {
  const tabPosition = new Map(tabOrder.map((tabId, index) => [tabId, index]))
  const positionFor = (task: SidebarTask): number => {
    let position = Number.MAX_SAFE_INTEGER
    for (const tabId of task.tabIds) {
      position = Math.min(position, tabPosition.get(tabId) ?? Number.MAX_SAFE_INTEGER)
    }
    return position
  }

  return [...tasks].sort((a, b) => {
    const position = positionFor(a) - positionFor(b)
    return position !== 0 ? position : a.createdAt - b.createdAt
  })
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
  initial: string
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
        initial: projectInitial(task.projectLabel),
        tasks: [],
      }
      groups.set(task.projectKey, group)
    }
    group.tasks.push(task)
  }

  return [...groups.values()].sort((a, b) => a.projectLabel.localeCompare(b.projectLabel))
}

/** 1–2 letters: the initial of each of the first two words, or just the first
 *  letter of a single-word name. "solus" → S, "model-routing" → MR. */
export function projectInitial(label: string): string {
  const words = label.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0][0].toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export interface ProjectSummary {
  projectKey: string
  label: string
  initial: string
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
      initial: projectInitial(tasks[0].projectLabel),
      count: tasks.length,
      waiting: tasks.filter((task) => task.status === 'question' || task.status === 'plan').length,
      failed: tasks.filter((task) => task.status === 'error').length,
      leadTaskKey: ranked[0].key,
    }
  })
}

export type ViewMode = 'flat' | 'grouped'

/** A grouped list states the project in its heading, so repeating it on every
 *  row under that heading is noise. A flat list has no heading to lean on:
 *  which project a task belongs to is part of reading the row, even when only
 *  one project happens to be open right now — a column whose rows change shape
 *  the moment a second project appears is harder to read than one that doesn't. */
export function showsProjectLine(mode: ViewMode): boolean {
  return mode === 'flat'
}

export type PrChipState = 'draft' | 'open' | 'approvalRequested' | 'merged'

export interface PrChip {
  number: number
  state: PrChipState
}

/**
 * Match a task's branch to an open PR by head ref, falling back to the number
 * the task record captured when it opened one. The live list is preferred
 * because it is the only thing that knows the PR's *state*; the recorded number
 * is what keeps the chip on a task whose PR the list doesn't carry — another
 * project's, or one already merged out of it — where it reads as plain open.
 *
 * `PullRequestSummary` carries no human verdict, so "approved" and "changes
 * requested" are not distinguishable here and render as plain open.
 */
export function prChipFor(
  branchName: string | null,
  prs: readonly PullRequestSummary[],
  recordedNumber: number | null = null,
): PrChip | null {
  const pr = branchName ? prs.find((item) => item.headRef === branchName) : undefined
  if (!pr) return recordedNumber ? { number: recordedNumber, state: 'open' } : null
  if (pr.state === 'merged') return { number: pr.number, state: 'merged' }
  if (pr.draft) return { number: pr.number, state: 'draft' }
  if (pr.needsMyReview) return { number: pr.number, state: 'approvalRequested' }
  return { number: pr.number, state: 'open' }
}
