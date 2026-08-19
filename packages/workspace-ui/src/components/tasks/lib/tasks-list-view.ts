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
  type InboxGroupSpec,
  type ListChipSpec,
  type ListGroupSpec,
  type ListPerson,
  type ListRowSource,
  type ListRowSpec,
} from '../../ui/list-page/list-page'
import { visibleLabels } from './tasks-api'

const SOLUS_FALLBACK: ListPerson = {
  id: 'solus',
  initials: 'S',
  name: 'Solus',
  fallback: 'solus',
}

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

/** `T-412`, the human-referenceable per-install id. Falls back to a short slice
 *  of the uuid so the column is never blank and never ragged. */
function identFor(task: Task): string {
  return task.shortId ? `T-${task.shortId}` : `T-${task.id.slice(0, 4)}`
}

/** Slot 2a — the provider the task lives in, shown as its brand logo before the
 *  id. Local (native) tasks read as a quiet dot; upstream tickets say they sync
 *  back so the mark isn't mistaken for a decoration. */
function sourceFor(task: Task): ListRowSource {
  if (task.providerId !== 'local') {
    return { id: task.providerId, title: 'GitHub · status and comments sync back' }
  }
  // A published or imported task is filed upstream even though Solus still owns
  // the row, and where other people can see the work is the more useful fact —
  // so the ticket's provider wins over "local" here.
  const mirrored = task.mirroredTicket
  if (mirrored) {
    return {
      id: mirrored.provider,
      title: `GitHub · synced with #${mirrored.externalId}`,
    }
  }
  return { id: 'local', title: 'Local task · lives in Solus' }
}

/**
 * Slot 4 — at most two chips. The first is the domain (the task's own label);
 * the second is only ever a state that genuinely needs colour, so a row that is
 * merely open carries no colour at all.
 */
function chipsFor(task: Task, now: number): ListChipSpec[] {
  const chips: ListChipSpec[] = []
  const label = visibleLabels(task)[0]
  if (label) chips.push({ label })

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
  if (task.branch) return task.branch
  return ''
}

export function taskRow(task: Task, activeSessions: number, now: number): ListRowSpec {
  return {
    key: task.id,
    ident: identFor(task),
    source: sourceFor(task),
    title: task.title,
    chips: chipsFor(task, now),
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

export function taskBoardCard(task: Task, activeSessions: number, now: number): BoardCardSpec {
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
    chips: chipsFor(task, now),
    people: task.assignee ? [personFrom(task.assignee, undefined, task.assigneeAvatarUrl)] : [],
    time: compactRelativeTime(task.updatedAt, now),
    timeTitle: absoluteTime(task.updatedAt),
  }
}

/** The grouped global list. Empty groups are dropped rather than shown at zero. */
export function taskGroups(
  tasks: Task[],
  sessionsFor: (taskId: string) => number,
  now: number,
): ListGroupSpec[] {
  return TASK_STATUS_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    rows: tasks
      .filter((task) => group.statuses.includes(task.status))
      .map((task) => taskRow(task, sessionsFor(task.id), now)),
  })).filter((group) => group.rows.length > 0)
}

/** Closed work, either way it closed. The board dims both and the card's meta
 *  line calls both "closed"; only the filter tells them apart. */
export function isDone(task: Task): boolean {
  return task.status === 'done' || task.status === 'dropped'
}

interface TaskInboxActions {
  open: (task: Task) => void
  start: (task: Task) => void
  resume: (task: Task) => void
  markDone: (task: Task) => void
}

/**
 * The personal inbox. The global list is for looking; this is for finishing, so
 * every row that can be cleared carries the one verb that clears it.
 *
 * Tasks are local records with a single viewer, so "needs you" is derived from
 * lifecycle rather than from an assignee identity: work that has reached review,
 * then work that is assigned and idle, then what is running. There is no
 * mentions group, because local tasks have no mention feed to read.
 *
 * Every group is a status, so the page's status filter reaches in here too and
 * the queue holds only the states asked for. Closed work is a group like any
 * other, and off by default — an inbox is a list of decisions, and finished
 * work is not one.
 */
export function taskInboxGroups(
  tasks: Task[],
  sessionsFor: (taskId: string) => number,
  now: number,
  actions: TaskInboxActions,
  statuses: Set<TaskStatus>,
): InboxGroupSpec[] {
  const groups: InboxGroupSpec[] = []
  const shown = tasks.filter((task) => statuses.has(task.status))

  const needsYou = shown.filter((task) => task.status === 'in_review')
  if (needsYou.length > 0) {
    groups.push({
      key: 'needs',
      label: 'Needs you',
      note: 'oldest first',
      accent: true,
      rows: [...needsYou]
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .map((task) => ({
          ...inboxRowBase(task, sessionsFor(task.id), now),
          title: `Review requested: ${task.title}`,
          context: reviewContext(task, sessionsFor(task.id)),
          unread: true,
          primary: { label: 'Review', shortcut: '⏎', run: () => actions.open(task) },
          secondary: { label: 'Mark done', run: () => actions.markDone(task) },
        })),
    })
  }

  // Assigned, not done, and nothing running — the agent is not going to move
  // these on its own, so they are waiting on a person.
  const waiting = shown.filter(
    (task) =>
      (task.status === 'todo' || task.status === 'inbox') &&
      sessionsFor(task.id) === 0,
  )
  if (waiting.length > 0) {
    groups.push({
      key: 'waiting',
      label: 'Waiting on you',
      note: 'no agent running',
      rows: [...waiting]
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .map((task) => ({
          ...inboxRowBase(task, 0, now),
          context: task.assignee ? `Assigned to ${task.assignee} · no session started` : 'No session started',
          unread: false,
          primary: { label: 'Start agent', shortcut: '⏎', run: () => actions.start(task) },
        })),
    })
  }

  const running = shown.filter((task) => task.status === 'in_progress' && sessionsFor(task.id) > 0)
  if (running.length > 0) {
    groups.push({
      key: 'running',
      label: 'Agent running',
      rows: [...running]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((task) => ({
          ...inboxRowBase(task, sessionsFor(task.id), now),
          context: `${sessionsFor(task.id)} live session${sessionsFor(task.id) === 1 ? '' : 's'}${task.branch ? ` · ${task.branch}` : ''}`,
          unread: false,
          primary: { label: 'Resume', shortcut: '⏎', run: () => actions.resume(task) },
        })),
    })
  }

  const closed = shown.filter(isDone)
  if (closed.length > 0) {
    groups.push({
      key: 'done',
      label: 'Done',
      note: 'newest first',
      rows: [...closed]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((task) => ({
          ...inboxRowBase(task, 0, now),
          context: task.pr ? `Closed · PR #${task.pr.number}` : 'Closed',
          unread: false,
        })),
    })
  }

  return groups
}

function inboxRowBase(task: Task, activeSessions: number, now: number) {
  return {
    key: task.id,
    ident: identFor(task),
    title: task.title,
    context: '',
    actor: task.assignee
      ? personFrom(task.assignee, undefined, task.assigneeAvatarUrl)
      : SOLUS_FALLBACK,
    time: compactRelativeTime(task.updatedAt, now),
    timeTitle: absoluteTime(task.updatedAt),
    unread: false,
    chips: activeSessions > 0 ? [{ label: 'running', tint: 'running' as const }] : [],
  }
}

function reviewContext(task: Task, activeSessions: number): string {
  const parts: string[] = []
  if (activeSessions > 0) parts.push(`${activeSessions} session${activeSessions === 1 ? '' : 's'}`)
  if (task.pr) parts.push(`PR #${task.pr.number}`)
  else if (task.branch) parts.push(task.branch)
  return parts.length > 0 ? parts.join(' · ') : 'Ready for your review'
}
