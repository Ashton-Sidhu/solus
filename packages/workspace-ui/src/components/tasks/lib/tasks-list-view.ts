/**
 * Maps `Task` records into the shared list-page grammar ("List pages" spec,
 * Part B — Tasks). Pure and non-reactive: TasksPage reads these from `$derived`.
 *
 * The page declares only what is its own — which groups, which columns, which
 * chips, which verbs. Everything about how a row is *drawn* lives in
 * `components/ui/list-page`.
 */
import type { Task } from '@solus/contracts/task-types'
import type { TaskStatusCategory } from '@solus/contracts/task-sources'
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
import { formatWakeIn } from '../../session/lib/task-list'
import { PROVIDER_NAMES, taskRef, type BoardColumn } from './tasks-api'

/** A snoozed task is out of the task lists until it wakes. The snooze is
 *  independent of the status: any task can sleep, and its agents keep working. */
export function isTaskSnoozed(task: Pick<Task, 'snoozedUntil'>, now: number): boolean {
  return !!task.snoozedUntil && task.snoozedUntil > now
}

/** The earliest wake time still ahead, so a list can bring the task back on
 *  time. Null when nothing is snoozed. */
export function nextTaskWake(tasks: readonly Pick<Task, 'snoozedUntil'>[], now: number): number | null {
  let next: number | null = null
  for (const { snoozedUntil } of tasks) {
    if (snoozedUntil && snoozedUntil > now && (next === null || snoozedUntil < next)) next = snoozedUntil
  }
  return next
}

/**
 * What a list opens on: the columns of work that is not done. Finished work
 * is history — reachable in one click, but never in the way of what is still
 * moving. The column of a board's items that have no column yet is open work.
 */
export function openColumnIds(columns: readonly Pick<BoardColumn<Task>, 'id' | 'category'>[]): string[] {
  return columns.filter((column) => column.category !== 'done').map((column) => column.id)
}

/** Whether the column filter is the one a list opens on, so it counts as no filter. */
export function isOpenColumnFilter(
  columns: readonly Pick<BoardColumn<Task>, 'id' | 'category'>[],
  selected: readonly string[],
): boolean {
  const open = openColumnIds(columns)
  return selected.length === open.length && open.every((id) => selected.includes(id))
}

/** Slot 2a — the provider that owns the task, shown as its brand logo before
 *  the reference. The title names the whole reference, which the cell shortens. */
function sourceFor(task: Task): ListRowSource {
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

function chipsFor(task: Task, now: number, homeFor?: TaskHomeLabel): ListChipSpec[] {
  const chips: ListChipSpec[] = []
  const home = homeFor?.(task.id)
  if (home) chips.push({ label: home })
  const label = task.labels[0]
  if (label) chips.push({ label, labelColor: 'var(--solus-accent)' })

  const overdue =
    task.dueDate && task.category !== 'done'
      ? Date.parse(`${task.dueDate}T23:59:59`) < now
      : false
  // Only the Snoozed filter shows a sleeping task, so its return time is the
  // state that matters most there.
  const wakeAt = task.snoozedUntil ?? 0
  if (wakeAt > now) chips.push({ label: `wakes in ${formatWakeIn(wakeAt, now)}`, tint: 'info' })
  else if (overdue) chips.push({ label: 'overdue', tint: 'failure' })
  else if (task.priority === 'urgent') chips.push({ label: 'urgent', tint: 'failure' })
  else if (task.priority === 'high') chips.push({ label: 'high', tint: 'warning' })

  return chips
}

/**
 * Slot 6 — the page's one sentence of machine state: what is happening to this
 * task. Finished work says so in words, because on the board that sentence is
 * the whole middle line of the card. Open work is deliberately silent — nothing
 * has happened to it yet, and "—" reads worse than nothing.
 */
function metaFor(task: Task, activeSessions: number): string {
  if (activeSessions > 0) return `agent · ${activeSessions} session${activeSessions === 1 ? '' : 's'}`
  if (task.category === 'done') return task.pr ? `closed · #${task.pr.number}` : 'closed'
  if (task.pr) return `PR #${task.pr.number}`
  return ''
}

/** A list row names where the task lives in its own column, so its chips keep
 *  only the label and the state that needs colour. */
export function taskRow(task: Task, activeSessions: number, now: number, placeFor?: TaskPlaceFor): ListRowSpec {
  return {
    key: task.id,
    ident: taskRef(task),
    source: sourceFor(task),
    title: task.title,
    chips: chipsFor(task, now),
    place: placeFor?.(task.id),
    meta: metaFor(task, activeSessions),
    people: task.assignee
      ? [personFrom(task.assignee, undefined, task.assigneeAvatarUrl)]
      : [],
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
  category: TaskStatusCategory
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

export function taskBoardCard(task: Task, activeSessions: number, now: number, homeFor?: TaskHomeLabel): BoardCardSpec {
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
    people: task.assignee ? [personFrom(task.assignee, undefined, task.assigneeAvatarUrl)] : [],
    time: compactRelativeTime(task.updatedAt, now),
    timeTitle: absoluteTime(task.updatedAt),
  }
}

/** The grouped list: one section for each column of the view, in the view's
 *  order, so the list and the board group the same way. Empty sections are
 *  dropped rather than shown at zero. */
export function taskGroups(
  columns: readonly BoardColumn<Task>[],
  runningSessionsFor: (taskId: string) => number,
  now: number,
  placeFor?: TaskPlaceFor,
): ListGroupSpec[] {
  return columns
    .filter((column) => column.tasks.length > 0)
    .map((column) => ({
      key: column.id,
      label: column.label,
      rows: column.tasks.map((task) => taskRow(task, runningSessionsFor(task.id), now, placeFor)),
    }))
}

export function isDone(task: Pick<Task, 'category'>): boolean {
  return task.category === 'done'
}
