// Shaping for the rail's Task card. The card is an index of one task: who it
// is and every object linked to it. Per the renderer rules the .svelte holds
// markup and thin handlers; the row grammar lives here.
import {
    RefreshCw as ArrowsClockwiseIcon,
    ClipboardList as ClipboardTextIcon,
    FileText as FileTextIcon,
    GitPullRequest as GitPullRequestIcon,
    Network as ArchitectureIcon,
    AppWindow as ArtifactIcon,
    Presentation as PresentationIcon,
  } from "@lucide/svelte";
  import type { Automation, WorkMeta } from '@solus/contracts/types'
import type { Task, TaskLink, TaskLinkKind } from '@solus/contracts/task-types'
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
