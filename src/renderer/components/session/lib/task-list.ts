import type { PullRequestSummary } from '../../../../shared/providers'
import type { AttentionState } from '../../../lib/sessionUtils'

/** The sidebar's state vocabulary. Narrower than `AttentionState`: the column
 *  reports what a task wants from a person, so "finished but unread" is not a
 *  state here — it is an idle task with a bolder title.
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

/** Unread output and states that need a person use the same title weight as
 *  selection. The status glyph still carries the specific reason. */
export function sidebarTitleNeedsEmphasis(status: TaskStatus, unread: boolean): boolean {
  return unread || hasGlyph(status)
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
  /** Current branch key. This is navigation data and may change while a
   *  pending worktree resolves. */
  key: string
  title: string
  projectKey: string
  projectLabel: string
  /** Real git branch, matched against a PR's head ref. Null off a branch. */
  branchName: string | null
  status: TaskStatus
  /** The raw state behind `status`, kept so glyphs can be labelled in the
   *  app's own words rather than the sidebar's narrower vocabulary. */
  attention: AttentionState
  /** True while a session finished with output the user has not seen. Bolds the
   *  title without spending a glyph on it. */
  unread: boolean
  /** Sort tie-break: most recent activity first. */
  activityAt: number
  /** Start of the turn in flight, for the elapsed readout. 0 unless running. */
  runStartedAt: number
  tabIds: string[]
}

export type SidebarTaskData = Omit<SidebarTask, 'id'>

/** Assign one stable renderer identity to each current task. A task keeps its
 *  identity while any session remains in it, even if its branch key changes or
 *  its lead session closes. If one task temporarily splits while environments
 *  resolve, each rendered row still receives a unique identity. */
export function identifySidebarTasks(
  identityByTabId: Map<string, string>,
  tasks: SidebarTaskData[],
): SidebarTask[] {
  const claimedIds = new Set<string>()
  const liveTabIds = new Set<string>()

  const identified = tasks.map((task) => {
    const previousId = task.tabIds
      .map((tabId) => identityByTabId.get(tabId))
      .find((id) => id !== undefined && !claimedIds.has(id))
    const id = previousId ?? task.tabIds.find((tabId) => !claimedIds.has(tabId)) ?? task.key

    claimedIds.add(id)
    for (const tabId of task.tabIds) {
      liveTabIds.add(tabId)
      identityByTabId.set(tabId, id)
    }
    return { ...task, id }
  })

  for (const tabId of identityByTabId.keys()) {
    if (!liveTabIds.has(tabId)) identityByTabId.delete(tabId)
  }
  return identified
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
      previous.key === next.key &&
      previous.title === next.title &&
      previous.projectKey === next.projectKey &&
      previous.projectLabel === next.projectLabel &&
      previous.branchName === next.branchName &&
      previous.status === next.status &&
      previous.attention === next.attention &&
      previous.unread === next.unread &&
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
 * The projects behind the breadcrumb's picker. Built from the *unfiltered* task
 * list: the counts must not change when a filter is on, or the way back would
 * renumber itself.
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

/** Show the per-row project only when the flat list actually mixes projects.
 *  A group heading, project filter, or single-project list already supplies
 *  that context, so repeating it inside every task is noise. */
export function showsProjectLine(
  mode: ViewMode,
  projectFilter: string | null,
  projectCount: number,
): boolean {
  return mode === 'flat' && projectFilter === null && projectCount > 1
}

export type TrailingSlot = 'status' | 'elapsed' | 'pr' | 'none'

/**
 * One slot, one occupant. Live status wins because it says what needs attention
 * now; running time comes next; a PR is standing context for an otherwise idle
 * task. The PR chip alone yields to hover actions.
 *
 * The chip still steps aside on hover (that swap is CSS) to make room for the
 * row's actions.
 */
export function trailingSlot(status: TaskStatus, hasPr: boolean, hovered: boolean): TrailingSlot {
  if (hasGlyph(status)) return 'status'
  if (status === 'running') return 'elapsed'
  if (hasPr && !hovered) return 'pr'
  return 'none'
}

export type PrChipState = 'draft' | 'open' | 'approvalRequested' | 'merged'

export interface PrChip {
  number: number
  state: PrChipState
}

/**
 * Match a task's branch to an open PR by head ref. Returns null when the PR
 * list has not loaded — the chip states standing information, and a guess is
 * worse than an empty slot.
 *
 * `PullRequestSummary` carries no human verdict, so "approved" and "changes
 * requested" are not distinguishable here and render as plain open.
 */
export function prChipFor(
  branchName: string | null,
  prs: readonly PullRequestSummary[],
): PrChip | null {
  if (!branchName) return null
  const pr = prs.find((item) => item.headRef === branchName)
  if (!pr) return null
  if (pr.state === 'merged') return { number: pr.number, state: 'merged' }
  if (pr.draft) return { number: pr.number, state: 'draft' }
  if (pr.needsMyReview) return { number: pr.number, state: 'approvalRequested' }
  return { number: pr.number, state: 'open' }
}
