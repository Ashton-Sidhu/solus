/**
 * Maps `Task` records into the shared list-page grammar ("List pages" spec,
 * Part B — Tasks). Pure and non-reactive: TasksPage reads these from `$derived`.
 *
 * The page declares only what is its own — which groups, which columns, which
 * chips, which verbs. Everything about how a row is *drawn* lives in
 * `components/ui/list-page`.
 */
import type { Task, TaskStatus } from '@solus/contracts/task-types'
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
import { PROVIDER_NAMES, ticketRef } from '../task-page/lib/task-upstream'
import { visibleLabels } from './tasks-api'

/**
 * Lifecycle state is carried by the section a row sits in, so it costs no row
 * width and sorts the page for you. Fixed order — the further down, the less it
 * wants your attention.
 *
 * These double as the status filter's options: one entry per state a person
 * would name, which is why `inbox` (untriaged) sits inside Todo, while finished
 * and abandoned work is split — "I closed this without doing it" is a different
 * answer from "I did it", and either one may be the one you came looking for.
 */
export const TASK_STATUS_GROUPS: { key: string; label: string; statuses: TaskStatus[] }[] = [
  { key: 'in_progress', label: 'In progress', statuses: ['in_progress'] },
  { key: 'in_review', label: 'In review', statuses: ['in_review'] },
  { key: 'todo', label: 'Todo', statuses: ['inbox', 'todo'] },
  { key: 'done', label: 'Done', statuses: ['done'] },
  { key: 'dropped', label: 'Closed', statuses: ['dropped'] },
]

/** What a list opens on: live work only. Finished and abandoned work is history
 *  — reachable in one click, but never in the way of what is still moving. */
export const OPEN_TASK_STATUS_KEYS = ['in_progress', 'in_review', 'todo']

/** Expand picked group keys into the raw statuses a row is matched against. */
export function taskStatusesFor(keys: readonly string[]): Set<TaskStatus> {
  const statuses = new Set<TaskStatus>()
  for (const group of TASK_STATUS_GROUPS) {
    if (keys.includes(group.key)) for (const status of group.statuses) statuses.add(status)
  }
  return statuses
}

/**
 * `T-412`, the human-referenceable per-install id.
 *
 * A provider-owned ticket has no Solus number — its `id` *is* the provider's
 * own reference — so it keeps that reference (`#412`, `ACME-12`) rather than
 * being dressed as a native task. Slicing it produced `T-ACME`: an id the user
 * cannot look up, and one that reads as a truncated cell.
 */
function identFor(task: Task): string {
  if (task.providerId !== 'local') return ticketRef(task.providerId, task.id)
  return task.shortId ? `T-${task.shortId}` : `T-${task.id.slice(0, 4)}`
}

/** Slot 2a — the provider the task lives in, shown as its brand logo before the
 *  id. Local (native) tasks read as a quiet dot; upstream tickets say they sync
 *  back so the mark isn't mistaken for a decoration. */
function sourceFor(task: Task): ListRowSource {
  if (task.providerId !== 'local') {
    return {
      id: task.providerId,
      title: `${PROVIDER_NAMES[task.providerId]} · status and comments sync back`,
    }
  }
  // A published or imported task is filed upstream even though Solus still owns
  // the row, and where other people can see the work is the more useful fact —
  // so the ticket's provider wins over "local" here.
  const mirrored = task.mirroredTicket
  if (mirrored) {
    return {
      id: mirrored.provider,
      title: `${PROVIDER_NAMES[mirrored.provider]} · synced with ${ticketRef(
        mirrored.provider,
        mirrored.externalId,
      )}`,
    }
  }
  return { id: 'local', title: 'Local task · lives in Solus' }
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
  const label = visibleLabels(task)[0]
  if (label) chips.push({ label, labelColor: 'var(--solus-accent)' })

  const overdue =
    task.dueDate && task.status !== 'done' && task.status !== 'dropped'
      ? Date.parse(`${task.dueDate}T23:59:59`) < now
      : false
  if (overdue) chips.push({ label: 'overdue', tint: 'failure' })
  else if (task.priority === 'urgent') chips.push({ label: 'urgent', tint: 'failure' })
  else if (task.priority === 'high') chips.push({ label: 'high', tint: 'warning' })

  return chips
}

/**
 * Slot 6 — the page's one sentence of machine state: what is happening to this
 * task, or what it wants from you. Work that has reached review or closed says
 * so in words, because on the board that sentence is the whole middle line of
 * the card. Todo is deliberately silent — nothing has happened to it yet, and
 * "—" reads worse than nothing.
 */
function metaFor(task: Task, activeSessions: number): string {
  if (activeSessions > 0) return `agent · ${activeSessions} session${activeSessions === 1 ? '' : 's'}`
  if (task.status === 'in_review') {
    return task.pr ? `review requested · #${task.pr.number}` : 'review requested'
  }
  if (task.status === 'done' || task.status === 'dropped') {
    return task.pr ? `closed · #${task.pr.number}` : 'closed'
  }
  if (task.pr) return `PR #${task.pr.number}`
  return ''
}

/** A list row names where the task lives in its own column, so its chips keep
 *  only the label and the state that needs colour. */
export function taskRow(task: Task, activeSessions: number, now: number, placeFor?: TaskPlaceFor): ListRowSpec {
  return {
    key: task.id,
    ident: identFor(task),
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
  lifecycle: TaskStatus
  title: string
  /** The Done column's titles step back — they are history, not work. */
  dimmed: boolean
  /** The card's one line of machine state, same sentence the list row shows. */
  status: string
  /** An agent is running on this task — the status line takes the running tint. */
  live: boolean
  /** The status line is asking for something from you, so it takes the brand
   *  tint rather than reading as inert metadata. */
  attention: boolean
  chips: ListChipSpec[]
  people: ListPerson[]
  time: string
  timeTitle?: string
}

export function taskBoardCard(task: Task, activeSessions: number, now: number, homeFor?: TaskHomeLabel): BoardCardSpec {
  return {
    key: task.id,
    ident: identFor(task),
    source: sourceFor(task),
    lifecycle: task.status,
    title: task.title,
    dimmed: task.status === 'done' || task.status === 'dropped',
    status: metaFor(task, activeSessions),
    live: activeSessions > 0,
    attention: activeSessions === 0 && task.status === 'in_review',
    chips: chipsFor(task, now, homeFor),
    people: task.assignee ? [personFrom(task.assignee, undefined, task.assigneeAvatarUrl)] : [],
    time: compactRelativeTime(task.updatedAt, now),
    timeTitle: absoluteTime(task.updatedAt),
  }
}

/** The grouped global list. Empty groups are dropped rather than shown at zero. */
export function taskGroups(
  tasks: Task[],
  runningSessionsFor: (taskId: string) => number,
  now: number,
  placeFor?: TaskPlaceFor,
): ListGroupSpec[] {
  return TASK_STATUS_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    rows: tasks
      .filter((task) => group.statuses.includes(task.status))
      .map((task) => taskRow(task, runningSessionsFor(task.id), now, placeFor)),
  })).filter((group) => group.rows.length > 0)
}

/** Closed work, either way it closed. The board dims both and the card's meta
 *  line calls both "closed"; only the filter tells them apart. */
export function isDone(task: Task): boolean {
  return task.status === 'done' || task.status === 'dropped'
}
