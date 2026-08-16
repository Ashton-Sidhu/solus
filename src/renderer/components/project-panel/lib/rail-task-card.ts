// Shaping for the rail's Task card. The card is an index of one task: who it
// is, the sessions working it, and every object linked to it. Per the renderer
// rules the .svelte holds markup and thin handlers; the row grammar lives here.
import {
  ArrowsClockwiseIcon,
  ChatTeardropIcon,
  CheckCircleIcon,
  ClipboardTextIcon,
  ClockIcon,
  FileTextIcon,
  GitPullRequestIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from 'phosphor-svelte'
import type { Automation } from '../../../../shared/types'
import type { Task, TaskLink, TaskLinkKind, TaskSessionLink } from '../../../../shared/task-types'
import { sessionDisplayName, type AttentionState } from '../../../lib/sessionUtils'
import { clockTime } from '../../automations/lib/automation-format'
import { STATUS_META } from '../../tasks/lib/tasks-api'
import { linkRow } from '../../tasks/task-page/lib/task-page'

/** A Phosphor icon component, named the way `MenuRow` names its own. */
export type RailIcon = typeof FileTextIcon

/** Compact duration for the mono column — "4m", "21m", "2d". Deliberately not
 *  `formatTimeAgo`: the column is a width-critical reading, so it drops the
 *  "ago" the prose elsewhere keeps. */
export function compactAge(ts: number, now = Date.now()): string {
  const mins = Math.floor((now - ts) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

/** Seconds-resolution elapsed — "48s", "4m 12s", "1h 06m". Only a running row
 *  spends this: it ticks, so it needs a digit that visibly moves, which the
 *  minute-resolution `compactAge` above does not have. */
export function liveElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  if (hours) return `${hours}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`
  const mins = Math.floor(total / 60)
  return mins ? `${mins}m ${String(total % 60).padStart(2, '0')}s` : `${total}s`
}

const DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const DAY_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** When the task was opened, as an absolute day — the same call the task page
 *  makes for attempts, because a task is a thing with a place in a history and
 *  "29m" does not line it up against anything. The year is only spelled out
 *  once the task is old enough to need it. */
function taskOpenedDate(task: Task, now = Date.now()): string {
  if (!task.createdAt) return ''
  const created = new Date(task.createdAt)
  const thisYear = created.getFullYear() === new Date(now).getFullYear()
  return (thisYear ? DAY : DAY_WITH_YEAR).format(created)
}

/** The ref link's hover: what the task is, when it was opened, and what
 *  clicking does. The ref is already where you point when you want the task
 *  itself, so it is where that provenance earns its keep — beside the section
 *  label the date was decoration, since nothing in the card is read against
 *  it. */
export function taskRefTooltip(task: Task, now = Date.now()): string {
  const title = task.title?.trim() || 'Untitled task'
  const opened = taskOpenedDate(task, now)
  return opened ? `${title}\nOpened ${opened} · open task page` : `${title}\nOpen task page`
}

/** One icon per state, coloured by its status token and nothing else — no dot,
 *  no pill, no accent bar. The icons are the app's own: each state takes the
 *  same Phosphor glyph `getAttentionIcon` gives the sidebar and the tab strip,
 *  so a running session looks the same wherever it is reported. The colour is
 *  the card's, from the spec's status tokens. */
interface RailSessionState {
  label: string
  color: string
  icon: RailIcon
  spin?: boolean
}

const SESSION_STATES = new Map<string, RailSessionState>(Object.entries({
  // Running takes the sidebar's cool tone, not terracotta: work in flight only
  // wants a glance, and the warm family stays reserved for states that want you.
  running: { label: 'Running', color: 'var(--chart-5)', icon: SpinnerGapIcon, spin: true },
  awaiting: { label: 'Needs you', color: 'var(--primary)', icon: ChatTeardropIcon },
  awaiting_plan: { label: 'Needs you', color: 'var(--primary)', icon: FileTextIcon },
  error: {
    label: 'Failed',
    color: 'color-mix(in oklch, var(--failure) 70%, var(--foreground))',
    icon: XCircleIcon,
  },
  queued: { label: 'Queued', color: 'var(--idle)', icon: ClockIcon },
}))

const DONE = { label: 'Done', icon: CheckCircleIcon }

export interface RailSessionRow {
  sessionId: string
  title: string
  /** The state as a word, for `title` and `aria-label` — colour alone must not
   *  carry it, and the glyph is all the row spends on it visually. */
  stateLabel: string
  icon: RailIcon
  /** Colour for the icon, or null for a finished session that reads muted. */
  iconColor: string | null
  /** Only the running spinner turns; every other state is a still glyph. */
  spin: boolean
  /** The right-hand reading: how long the attempt has run, or how long ago it
   *  was. A failure says so with its glyph and nothing else — the reason is a
   *  paragraph, and the rail's value column is a word wide. */
  value: string
  /** Elapsed is a width-critical number, so it sets in mono. */
  valueMono: boolean
  /** The absolute start, for the row's tooltip. */
  startedAt: string
  running: boolean
  /** The session the rail is describing sits on a resting wash. */
  current: boolean
  /** Finished sessions sit back so the live ones carry the eye. */
  dimmed: boolean
}

export function railSessionRow(
  link: TaskSessionLink,
  liveTitle: string | null,
  attention: AttentionState,
  current: boolean,
  now: number,
  taskTitle?: string | null,
): RailSessionRow {
  const state = attention ? SESSION_STATES.get(attention) : undefined
  const running = attention === 'running'
  return {
    sessionId: link.sessionId,
    title: sessionDisplayName({ link, liveTitle, taskTitle }),
    stateLabel: state?.label ?? DONE.label,
    icon: state?.icon ?? DONE.icon,
    iconColor: state?.color ?? null,
    spin: state?.spin === true,
    value: running ? liveElapsed(now - link.linkedAt) : compactAge(link.linkedAt, now),
    valueMono: true,
    startedAt: FULL.format(new Date(link.linkedAt)),
    running,
    current,
    dimmed: !state,
  }
}

/** Current session first, then newest — the attempt you are reading is the one
 *  the card is about, and everything else is history behind it. */
export function orderSessionLinks(
  links: TaskSessionLink[],
  currentSessionId: string | null,
): TaskSessionLink[] {
  return [...links].sort((a, b) => {
    if (a.sessionId === currentSessionId) return -1
    if (b.sessionId === currentSessionId) return 1
    return b.linkedAt - a.linkedAt
  })
}

export interface RailTaskAttempt {
  task: Task
  link: TaskSessionLink
}

/** Collect every attempt in one durable task family. A parent attempt and its
 * child-task attempts belong in the same project-rail history even though the
 * session-link store correctly keeps them under different task ids. */
export function taskFamilyAttempts(
  tasks: Task[],
  linksFor: (taskId: string) => TaskSessionLink[],
  currentSessionId: string | null,
): RailTaskAttempt[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const links = tasks.flatMap((task) => linksFor(task.id))
  return orderSessionLinks(links, currentSessionId).flatMap((link) => {
    const task = taskById.get(link.taskId)
    return task ? [{ task, link }] : []
  })
}

export interface RailSubtaskRow {
  task: Task
  statusLabel: string
  sessionLabel: string
  current: boolean
  dimmed: boolean
}

/** A durable child stays visible even before it has a session. The focused
 * child gets the same resting wash as the focused attempt, while completed
 * siblings step back without disappearing from the task family. */
export function railSubtaskRow(
  task: Task,
  currentTaskId: string,
  sessionCount: number,
): RailSubtaskRow {
  return {
    task,
    statusLabel: STATUS_META[task.status].label,
    sessionLabel: sessionCount === 0
      ? 'No sessions'
      : `${sessionCount} session${sessionCount === 1 ? '' : 's'}`,
    current: task.id === currentTaskId,
    dimmed: task.status === 'done' || task.status === 'dropped',
  }
}

/** Type glyphs, again the app's own rather than the mock's: a PR reads as it
 *  does on the PRs page, a doc as it does in Folio, and an automation as it
 *  does one card down in this same rail. */
const LINK_ICONS = {
  pr: GitPullRequestIcon,
  plan: ClipboardTextIcon,
  work: FileTextIcon,
  automation: ArrowsClockwiseIcon,
} satisfies Record<TaskLinkKind, RailIcon>

const LINK_KIND_LABELS = {
  work: { one: 'doc', many: 'docs' },
  plan: { one: 'plan', many: 'plans' },
  pr: { one: 'PR', many: 'PRs' },
  automation: { one: 'automation', many: 'automations' },
} satisfies Record<TaskLinkKind, { one: string; many: string }>

/** PR states that mean the work is over, so the row can sit back. */
const CLOSED_PR_STATES = new Set(['merged', 'closed'])

export interface RailLinkRow extends Omit<ReturnType<typeof linkRow>, 'icon'> {
  icon: RailIcon
  /** The row's one right-hand reading, formatted per kind. */
  value: string
  valueMono: boolean
  dimmed: boolean
}

export interface RailLinkList {
  rows: RailLinkRow[]
  /** Label for the collapse row, or null when nothing was held back. */
  moreLabel: string | null
  total: number
}

/** Every link kind resolves to the same row shape, so a new kind needs a glyph
 *  and a value formatter and nothing else. A doc reports when it was attached,
 *  an automation when it next fires, and a PR or plan its state as a word. */
interface RailLinkValue {
  value: string
  valueMono: boolean
  dimmed: boolean
}

function linkValue(
  link: TaskLink,
  automationFor: (id: string) => Automation | undefined,
  now: number,
): RailLinkValue {
  const status = (link.liveStatus ?? '').toLowerCase()
  switch (link.kind) {
    case 'pr':
      return { value: status, valueMono: false, dimmed: CLOSED_PR_STATES.has(status) }
    case 'plan':
      return { value: status, valueMono: false, dimmed: status === 'rejected' }
    case 'work':
      return { value: compactAge(link.linkedAt, now), valueMono: true, dimmed: false }
    case 'automation': {
      const next = automationFor(link.targetKey)?.nextRunAt
      if (status === 'paused') return { value: 'paused', valueMono: false, dimmed: true }
      return next
        ? { value: clockTime(new Date(next)), valueMono: true, dimmed: false }
        : { value: '', valueMono: false, dimmed: false }
    }
  }
}

/** What the cap must not cut: an open PR and an undecided plan are live work,
 *  while a doc and anything already closed can wait behind the overflow row. */
function survivesTruncation(link: TaskLink): boolean {
  const status = (link.liveStatus ?? '').toLowerCase()
  if (link.kind === 'pr') return !CLOSED_PR_STATES.has(status)
  return link.kind === 'plan' && status === 'pending'
}

/** Newest first, capped, with the tail named rather than counted anonymously —
 *  "1 more doc" tells you what you are not seeing. Type is carried by each
 *  row's glyph, so the list stays flat instead of grouping by kind. */
export function railLinkList(
  links: TaskLink[],
  cap: number,
  automationFor: (id: string) => Automation | undefined,
  now = Date.now(),
): RailLinkList {
  const ordered = [...links].sort((a, b) => b.linkedAt - a.linkedAt)
  // The cap chooses by what is still live, then the survivors go back into
  // recency order — the list a reader sees is always sorted one way.
  const byUrgency = [...ordered].sort(
    (a, b) => Number(survivesTruncation(b)) - Number(survivesTruncation(a)),
  )
  const kept = new Set(byUrgency.slice(0, cap))
  const shown = ordered.filter((link) => kept.has(link))
  const hidden = ordered.filter((link) => !kept.has(link))
  const kinds = new Set(hidden.map((link) => link.kind))
  const noun =
    kinds.size === 1
      ? ` ${LINK_KIND_LABELS[[...kinds][0]][hidden.length === 1 ? 'one' : 'many']}`
      : ''
  return {
    rows: shown.map((link) => ({
      ...linkRow(link),
      icon: LINK_ICONS[link.kind],
      ...linkValue(link, automationFor, now),
    })),
    moreLabel: hidden.length ? `${hidden.length} more${noun}` : null,
    total: links.length,
  }
}
