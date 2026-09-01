// Shaping for the rail's Task card. The card is an index of one task: who it
// is, the sessions working it, and every object linked to it. Per the renderer
// rules the .svelte holds markup and thin handlers; the row grammar lives here.
import {
    RefreshCw as ArrowsClockwiseIcon,
    MessageSquare as ChatTeardropIcon,
    CircleCheck as CheckCircleIcon,
    ClipboardList as ClipboardTextIcon,
    Clock as ClockIcon,
    FileText as FileTextIcon,
    GitPullRequest as GitPullRequestIcon,
    Network as ArchitectureIcon,
    AppWindow as ArtifactIcon,
    Presentation as PresentationIcon,
    LoaderCircle as SpinnerGapIcon,
    CircleX as XCircleIcon,
  } from "@lucide/svelte";
  import type { Automation, WorkMeta } from '@solus/contracts/types'
import type { Task, TaskLink, TaskLinkKind, TaskSessionLink } from '@solus/contracts/task-types'
import { sessionDisplayName, type AttentionState } from '../../../lib/sessionUtils'
import { clockTime } from '../../automations/lib/automation-format'
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

/** Type glyphs, again the app's own rather than the mock's: a PR reads as it
 *  does on the PRs page, a doc as it does in Folio, and an automation as it
 *  does one card down in this same rail. */
const LINK_ICONS = {
  pr: GitPullRequestIcon,
  plan: ClipboardTextIcon,
  work: FileTextIcon,
  automation: ArrowsClockwiseIcon,
} satisfies Record<TaskLinkKind, RailIcon>

/** A work is three artifacts under one link kind, so the row reads its type
 *  from the live join (`liveStatus` carries `works.type`) and wears the same
 *  glyph the workspace ledger gives it. A deleted work has no live type left,
 *  so it falls back to the document glyph. */
const WORK_TYPES = {
  doc: { icon: FileTextIcon, label: 'Doc' },
  slides: { icon: PresentationIcon, label: 'Slides' },
  diagram: { icon: ArchitectureIcon, label: 'Diagram' },
  artifact: { icon: ArtifactIcon, label: 'Artifact' },
} satisfies Record<WorkMeta['type'], { icon: RailIcon; label: string }>

function workType(link: TaskLink): (typeof WORK_TYPES)[WorkMeta['type']] | null {
  if (link.kind !== 'work') return null
  const type = link.liveStatus
  return type === 'slides' || type === 'diagram' || type === 'artifact' ? WORK_TYPES[type] : WORK_TYPES.doc
}

/** PR states that mean the work is over, so the row can sit back. */
const CLOSED_PR_STATES = new Set(['merged', 'closed'])

export interface RailLinkRow extends Omit<ReturnType<typeof linkRow>, 'icon'> {
  icon: RailIcon
  /** The row's one right-hand reading, formatted per kind. */
  value: string
  valueMono: boolean
  dimmed: boolean
  /** Full row meaning for hover, focus, and assistive technology. */
  detailLabel: string
}

export interface RailLinkList {
  rows: RailLinkRow[]
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

/** Open PRs and undecided plans are live work, so they lead the compact rail
 *  list. Everything else follows by recency. */
function isActionableLink(link: TaskLink): boolean {
  const status = (link.liveStatus ?? '').toLowerCase()
  if (link.kind === 'pr') return !CLOSED_PR_STATES.has(status)
  return link.kind === 'plan' && status === 'pending'
}

/** Actionable first, then newest. The rail viewport owns containment, so every
 *  link stays available without an expand/collapse state. */
export function railLinkList(
  links: TaskLink[],
  automationFor: (id: string) => Automation | undefined,
  now = Date.now(),
  prTitleFor: (link: TaskLink) => string | undefined = () => undefined,
): RailLinkList {
  const ordered = [...links].sort(
    (a, b) =>
      Number(isActionableLink(b)) - Number(isActionableLink(a)) ||
      b.linkedAt - a.linkedAt,
  )
  return {
    rows: ordered.map((link) => {
      const work = workType(link)
      const row = {
        ...linkRow(link, link.kind === 'pr' ? prTitleFor(link) : undefined),
        icon: work?.icon ?? LINK_ICONS[link.kind],
        ...linkValue(link, automationFor, now),
      }
      if (work) row.kindLabel = work.label
      const linked = FULL.format(new Date(link.linkedAt))
      return {
        ...row,
        detailLabel: `${row.kindLabel} · ${row.label}\nLinked ${linked}`,
      }
    }),
    total: links.length,
  }
}
