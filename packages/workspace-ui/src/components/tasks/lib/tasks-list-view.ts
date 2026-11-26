/**
 * Maps `Task` records into the shared list-page grammar ("List pages" spec,
 * Part B — Tasks). Pure and non-reactive: TasksPage reads these from `$derived`.
 *
 * The page declares only what is its own — which groups, which columns, which
 * chips, which verbs. Everything about how a row is *drawn* lives in
 * `components/ui/list-page`.
 */
import type { Issue } from '@solus/contracts/task-types'
import type { IssueStatusCategory } from '@solus/contracts/task-sources'
import {
  absoluteTime,
  compactRelativeTime,
  personFrom,
  type ListChipSpec,
  type ListGroupSpec,
  type ListPerson,
  type ListRowPlace,
  type ListRowSource,
  type ListRowSpec,
} from '../../ui/list-page/list-page'
import { PROVIDER_NAMES, taskRef, type BoardColumn } from './tasks-api'

/**
 * What a list opens on: the columns of work that is not done. Finished work
 * is history — reachable in one click, but never in the way of what is still
 * moving. The column of a board's items that have no column yet is open work.
 */
export function openColumnIds(columns: readonly Pick<BoardColumn<Issue>, 'id' | 'category'>[]): string[] {
  return columns.filter((column) => column.category !== 'done').map((column) => column.id)
}

/** Whether the column filter is the one a list opens on, so it counts as no filter. */
export function isOpenColumnFilter(
  columns: readonly Pick<BoardColumn<Issue>, 'id' | 'category'>[],
  selected: readonly string[],
): boolean {
  const open = openColumnIds(columns)
  return selected.length === open.length && open.every((id) => selected.includes(id))
}

/** Slot 2a — the provider that owns the task, shown as its brand logo before
 *  the reference. The title names the whole reference, which the cell shortens. */
function sourceFor(task: Issue): ListRowSource {
  const provider = PROVIDER_NAMES[task.providerId]
  return {
    id: task.providerId,
    title: task.reference ? `${provider} · ${task.reference}` : `${provider} · draft item`,
  }
}

/**
 * Slot 4 — at most two chips. The first is the domain (the task's own label);
 * the second is only ever a state that genuinely needs colour, so a row that is
 * merely open carries no colour at all.
 */
/** Where a record lives, when that is not this machine: "Solus Cloud" for the workspace service. */
export type TaskHomeLabel = (taskId: string) => string | null

/** The list row's place column. Undefined when the page draws no such column,
 *  so every row of one list either has the cell or does not. */
export type TaskPlaceFor = (taskId: string) => ListRowPlace | undefined

function chipsFor(task: Issue, now: number, homeFor?: TaskHomeLabel): ListChipSpec[] {
  const chips: ListChipSpec[] = []
  const home = homeFor?.(task.id)
  if (home) chips.push({ label: home })
  const label = task.labels[0]
  if (label) chips.push({ label, labelColor: 'var(--solus-accent)' })
  const urgency = urgencyChip(task, now)
  if (urgency) chips.push(urgency)
  return chips
}

/** The one state that needs colour: overdue while the work is open, else an
 *  urgent or high priority. */
function urgencyChip(task: Issue, now: number): ListChipSpec | null {
  const overdue =
    task.dueDate && task.category !== 'done'
      ? Date.parse(`${task.dueDate}T23:59:59`) < now
      : false
  if (overdue) return { label: 'overdue', tint: 'failure' }
  if (task.priority === 'urgent') return { label: 'urgent', tint: 'failure' }
  if (task.priority === 'high') return { label: 'high', tint: 'warning' }
  return null
}

/** The people a task belongs to: every assignee the provider reports, else
 *  the one assignee of a provider that has only one. */
function assigneesOf(task: Issue): ListPerson[] {
  if (task.assignees && task.assignees.length > 0) {
    return task.assignees.map((assignee) => personFrom(assignee.login, undefined, assignee.avatarUrl))
  }
  return task.assignee ? [personFrom(task.assignee, undefined, task.assigneeAvatarUrl)] : []
}

/**
 * Slot 6 — the page's one sentence of machine state: what is happening to this
 * task. Finished work says so in words, because on the board that sentence is
 * the whole middle line of the card. Open work is deliberately silent — nothing
 * has happened to it yet, and "—" reads worse than nothing.
 */
function metaFor(task: Issue, activeSessions: number): string {
  if (activeSessions > 0) return `agent · ${activeSessions} session${activeSessions === 1 ? '' : 's'}`
  if (task.category === 'done') return task.pr ? `closed · #${task.pr.number}` : 'closed'
  if (task.pr) return `PR #${task.pr.number}`
  return ''
}

/** The task row's fixed heights, the same as the pull request row's: a
 *  virtualiser is told a slot height before layout, so `TaskListRow` states
 *  these as its own height. Beside an open task the row gets more room. */
export const TASK_LIST_ROW_HEIGHT = 62
export const TASK_LIST_SPLIT_ROW_HEIGHT = 76

/** The labels a row draws; the rest are counted as `+n`. */
const ROW_LABELS_SHOWN = 3

/** The task row's facts beyond the shared grammar: its status category for
 *  the state glyph, and its labels as pills on the facts line, the way the
 *  pull request row draws them. */
export interface TaskRowSpec extends ListRowSpec {
  category: IssueStatusCategory
  labels: string[]
  /** Labels past the ones drawn, as a `+n` after them. */
  moreLabels: number
}

/** One row of the task list, in the pull request row's shape: the state glyph,
 *  the title with the assignees and the state that needs colour, then where it
 *  lives — reference, place, machine state, labels — with the age at its end. */
export function taskRow(task: Issue, activeSessions: number, now: number, placeFor?: TaskPlaceFor): TaskRowSpec {
  const urgency = urgencyChip(task, now)
  return {
    key: task.id,
    ident: taskRef(task),
    source: sourceFor(task),
    title: task.title,
    category: task.category,
    chips: urgency ? [urgency] : [],
    labels: task.labels.slice(0, ROW_LABELS_SHOWN),
    moreLabels: Math.max(0, task.labels.length - ROW_LABELS_SHOWN),
    place: placeFor?.(task.id),
    meta: metaFor(task, activeSessions),
    people: assigneesOf(task),
    time: compactRelativeTime(task.updatedAt, now),
    timeTitle: absoluteTime(task.updatedAt),
  }
}

/**
 * One card on the kanban board. The column already says the status, so a card
 * only carries what varies *inside* a column: where it lives, what it is, what
 * the agent is doing, and who owns it.
 */
export interface BoardCardSpec {
  key: string
  ident: string
  source: ListRowSource
  /** Drives the card's status glyph. The column already says this, but the card
   *  travels — under the cursor mid-drag, and in a column you may have scrolled
   *  past the head of — so it carries its own mark. */
  category: IssueStatusCategory
  title: string
  /** The Done column's titles step back — they are history, not work. */
  dimmed: boolean
  /** The card's one line of machine state, same sentence the list row shows. */
  status: string
  /** An agent is running on this task — the status line takes the running tint. */
  live: boolean
  chips: ListChipSpec[]
  people: ListPerson[]
  time: string
  timeTitle?: string
}

export function taskBoardCard(task: Issue, activeSessions: number, now: number, homeFor?: TaskHomeLabel): BoardCardSpec {
  return {
    key: task.id,
    ident: taskRef(task),
    source: sourceFor(task),
    category: task.category,
    title: task.title,
    dimmed: task.category === 'done',
    status: metaFor(task, activeSessions),
    live: activeSessions > 0,
    chips: chipsFor(task, now, homeFor),
    people: assigneesOf(task),
    time: compactRelativeTime(task.updatedAt, now),
    timeTitle: absoluteTime(task.updatedAt),
  }
}

/** The grouped list: one section for each column of the view, in the view's
 *  order, so the list and the board group the same way. Empty sections are
 *  dropped rather than shown at zero. */
export function taskGroups(
  columns: readonly BoardColumn<Issue>[],
  runningSessionsFor: (taskId: string) => number,
  now: number,
  placeFor?: TaskPlaceFor,
): ListGroupSpec<TaskRowSpec>[] {
  return columns
    .filter((column) => column.tasks.length > 0)
    .map((column) => ({
      key: column.id,
      label: column.label,
      rows: column.tasks.map((task) => taskRow(task, runningSessionsFor(task.id), now, placeFor)),
    }))
}

export function isDone(task: Pick<Issue, 'category'>): boolean {
  return task.category === 'done'
}
