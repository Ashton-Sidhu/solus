// Pure helpers for the task page. Per the renderer rules, the .svelte files
// hold markup and thin handlers; the shaping lives here.
import type {
  Task,
  TaskComment,
  TaskEvent,
  TaskLink,
  TaskLinkKind,
  TaskPriority,
  TaskProviderId,
  TaskProviderStatus,
  TaskSessionLink,
  TaskStatus,
} from '@solus/contracts/task-types'
import type { DocProviderId } from '@solus/contracts/docs'
import type { Work } from '@solus/contracts/types'
import { sessionDisplayName } from '../../../../lib/sessionUtils'
import { PRIORITY_META, STATUS_META } from '../../lib/tasks-api'
import { linkedPrTitle } from './task-prs'

/**
 * The page width below which the properties rail has no column to sit in.
 *
 * Read off the `@container` on the task page root, which has no padding, so its
 * content box and its border box are one number.
 *
 * This is the only place the rung exists. The rail used to fold under the
 * content at a `@max-[60rem]` of its own while the sheet that replaces it — and
 * the button that opens the sheet — appeared at a JavaScript rung of 30rem,
 * which left every pane between the two with the properties stacked under the
 * comment composer and no way to reach them otherwise. Above the rung the rail
 * is a column, below it the whole rail is the sheet.
 */
export const TASK_RAIL_FOLD_MAX = 60 * 16

/** True once the properties rail has folded out of the content row. */
export function isTaskRailFolded(pageWidth: number): boolean {
  // Width 0 is the frame before the observer reports; answering "folded" then
  // would flash the sheet affordance on every mount on a wide display.
  return pageWidth > 0 && pageWidth <= TASK_RAIL_FOLD_MAX
}

/** `color-mix` against the foreground, the design's one recipe for turning a
 *  status token into readable text on either canvas. */
export function statusColor(token: string, strength = 62): string {
  return `color-mix(in oklch, var(${token}) ${strength}%, var(--foreground))`
}

export function statusTextColor(status: TaskStatus): string {
  return statusColor(STATUS_META[status]?.token ?? '--idle')
}

/** The machine an attempt ran on, already resolved against the saved hosts. */
export interface TaskSessionHost {
  label: string
  isRemote: boolean
}

export interface TaskSessionRow {
  sessionId: string
  title: string
  /** Which agent ran the attempt — the one fact that tells two attempts of the
   *  same task apart at a glance. Empty when the session is not indexed yet. */
  agent: string
  /** Which machine ran it. Null only when the host cannot be named at all —
   *  a link that predates the recorded host, on a task whose own host this
   *  client has not placed. The column says so rather than guessing "here". */
  host: TaskSessionHost | null
  /** When the attempt started, absolute: attempts are a history, and "3d ago"
   *  is worse than a date for lining them up against the activity feed. */
  date: string
  /** Full timestamp, for the row's `title`. */
  dateFull: string
  /** Drives the "Running" label beside the title and the Stop action; the table
   *  has no state column, since the lifecycle of a closed session is
   *  unknowable and a column of blanks would claim otherwise. */
  running: boolean
}

/** `sessions.provider` slugs as the session index writes them. */
const AGENT_LABELS = new Map([
  ['claude', 'Claude Code'],
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
])

const DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const DAY_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function taskSessionRow(
  link: TaskSessionLink,
  liveTitle: string | null,
  /** The open tab's agent, which a just-started session has before the session
   *  index has written a row to read the provider back from. */
  liveProvider: string | null,
  running: boolean,
  now: number,
  taskTitle?: string | null,
  host?: TaskSessionHost | null,
): TaskSessionRow {
  // The link is written when the session is first bound to the task, so its
  // timestamp is when the attempt started.
  const started = new Date(link.linkedAt)
  const thisYear = started.getFullYear() === new Date(now).getFullYear()
  const provider = liveProvider ?? link.provider
  return {
    sessionId: link.sessionId,
    title: sessionDisplayName({ link, liveTitle, taskTitle }),
    agent: provider ? (AGENT_LABELS.get(provider) ?? provider) : '',
    host: host ?? null,
    date: (thisYear ? DAY : DAY_WITH_YEAR).format(started),
    dateFull: FULL.format(started),
    running,
  }
}

const TASK_PROVIDER_LABELS = new Map<TaskProviderId, string>([
  ['github', 'GitHub'],
  ['jira', 'Jira'],
  ['local', 'Local task'],
])

/** The task page identifies the system that owns the task. */
export function taskProviderLabel(task: Task): string {
  return TASK_PROVIDER_LABELS.get(task.providerId) ?? task.providerId
}

interface TaskPageCapabilities {
  canEditContent: boolean
  canEditPlanningFields: boolean
  canEditPriority: boolean
  canEditLabels: boolean
  editableStatuses: TaskStatus[]
  canComment: boolean
}

/**
 * Capabilities exposed by the task detail page. GitHub's adapter supports
 * issue content, status, labels and comments, while due date and priority only
 * exist when the issue belongs to a Projects v2 board.
 */
export function taskPageCapabilities(
  task: Task,
  providerStatus?: TaskProviderStatus | null,
): TaskPageCapabilities {
  const isLocal = task.providerId === 'local'
  const writable = new Set(providerStatus?.writableFields ?? [])
  return {
    canEditContent: isLocal || (writable.has('title') && writable.has('body')),
    canEditPlanningFields: isLocal,
    canEditPriority: isLocal || writable.has('priority'),
    canEditLabels: isLocal || writable.has('labels'),
    editableStatuses: isLocal
      ? ['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped']
      : providerStatus?.statuses ?? [],
    canComment: true,
  }
}

// ── Priority ──

/** Three ascending bars, filled up to the level. Urgent fills in the failure
 *  colour so the top of the scale reads differently from the rest of it. */
const PRIORITY_BARS = new Map<TaskPriority, number>([
  ['urgent', 3],
  ['high', 3],
  ['medium', 2],
  ['low', 1],
])
const BAR_HEIGHTS = ['4px', '6.5px', '9px']

interface PriorityBar {
  height: string
  background: string
}

export function priorityBars(priority: TaskPriority | undefined): PriorityBar[] {
  const filled = priority ? PRIORITY_BARS.get(priority) ?? 0 : 0
  const on = priority === 'urgent'
    ? 'color-mix(in oklch, var(--failure) 70%, var(--foreground))'
    : 'color-mix(in oklch, var(--foreground) 62%, transparent)'
  const off = 'color-mix(in oklch, var(--foreground) 18%, transparent)'
  return BAR_HEIGHTS.map((height, index) => ({
    height,
    background: index < filled ? on : off,
  }))
}

export function priorityLabel(priority: TaskPriority | undefined): string {
  return priority ? PRIORITY_META[priority].label : 'No priority'
}

// ── Linked ──

/** Icon paths for the Linked table, matching the kinds the picker offers. */
const LINK_ICONS = new Map<TaskLinkKind, string>([
  ['work', 'M8.2 1.6H4.2a1.4 1.4 0 00-1.4 1.4v8a1.4 1.4 0 001.4 1.4h5.6a1.4 1.4 0 001.4-1.4V4.4zM8.2 1.6v2.8h3M5 7.4h4M5 9.8h2.6'],
  ['plan', 'M2.4 3.6l1.2 1.2 2-2M2.4 8.2l1.2 1.2 2-2M7.6 4h4M7.6 8.6h4'],
  ['automation', 'M7.6 1.8L3.6 7.6h3L6.2 12.2l4.2-6h-3z'],
  ['pr', 'M4 4.4a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8M4 12.4a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8M10 4.4a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8M4 4.4v5.2M10 4.4v1.9a2.4 2.4 0 01-2.4 2.4H5.6'],
])

/** A window frame: an `artifact` work is a rendered page, not a page of text,
 *  and the row says so before the kind column does. */
const ARTIFACT_ICON = 'M2.4 3.4a1.4 1.4 0 011.4-1.4h6.4a1.4 1.4 0 011.4 1.4v7.2a1.4 1.4 0 01-1.4 1.4H3.8a1.4 1.4 0 01-1.4-1.4zM2.4 5.4h9.2M4.4 3.9h.01M6 3.9h.01'

/** A `work` link's live status is the work's type, so the row can tell an
 *  artifact from a document without loading the work. */
export function isArtifactLink(link: TaskLink): boolean {
  return link.kind === 'work' && link.liveStatus === 'artifact'
}

/** Plural section names, which are also the filter labels. */
const LINK_KIND_LABELS = new Map<TaskLinkKind, { one: string; many: string }>([
  ['work', { one: 'Doc', many: 'Docs' }],
  ['plan', { one: 'Plan', many: 'Plans' }],
  ['pr', { one: 'PR', many: 'PRs' }],
  ['automation', { one: 'Automation', many: 'Automations' }],
])

/** Pull requests are not rows in the Linked table: they get their own section,
 *  which can carry live PR state a generic row has nowhere to put. */
const LINK_KIND_ORDER: TaskLinkKind[] = ['work', 'plan', 'automation']

export function linkedTableLinks(links: TaskLink[]): TaskLink[] {
  return links.filter((link) => link.kind !== 'pr')
}

/** The provider mark shown beside a linked work after its metadata is loaded. */
export function linkedWorkProvider(
  link: TaskLink,
  workFor: (workId: string) => Work | undefined,
): DocProviderId | null {
  return link.kind === 'work' ? workFor(link.targetKey)?.mirroredDoc?.provider ?? null : null
}

interface LinkRow {
  key: string
  link: TaskLink
  icon: string
  /** Live title when the target still exists, else the link-time snapshot. */
  label: string
  kindLabel: string
  /** The mono prefix, currently only a PR number. */
  ref: string
  meta: string
  /** An `artifact` work: the row can expand to render it in place. */
  isArtifact: boolean
}

/** A PR row's label is the live title when a client has read the pull request,
 *  so `livePrTitle` is passed by the surfaces that overlay `PrsStore`. */
export function linkRow(link: TaskLink, livePrTitle?: string): LinkRow {
  const ref = link.kind === 'pr' ? `#${link.targetKey}` : ''
  const artifact = isArtifactLink(link)
  return {
    key: `${link.kind}:${link.targetScope}:${link.targetKey}`,
    link,
    icon: artifact ? ARTIFACT_ICON : LINK_ICONS.get(link.kind) ?? '',
    label: link.kind === 'pr'
      ? linkedPrTitle(link, ref, livePrTitle)
      : link.liveTitle || link.title,
    kindLabel: artifact ? 'Artifact' : LINK_KIND_LABELS.get(link.kind)?.one ?? link.kind,
    ref,
    // A work's live status is its type, which the kind column already states.
    meta: artifact ? '' : link.liveStatus ?? '',
    isArtifact: artifact,
  }
}

interface LinkFilter {
  label: string
  kind: TaskLinkKind | null
  count: number
}

/** All, then one filter per kind that actually has links. Kinds with nothing
 *  in them are omitted rather than shown as a dead zero. */
export function linkFilters(links: TaskLink[]): LinkFilter[] {
  const filters: LinkFilter[] = [{ label: 'All', kind: null, count: links.length }]
  for (const kind of LINK_KIND_ORDER) {
    const count = links.filter((link) => link.kind === kind).length
    if (count) filters.push({ label: LINK_KIND_LABELS.get(kind)?.many ?? kind, kind, count })
  }
  return filters
}

// ── Activity ──

/** The feed is comments and events merged by time. Comments have no mirrored
 *  event — `task_comments` is already that log — so the merge happens here. */
type ActivityEntry =
  | { type: 'comment'; at: number; key: string; comment: TaskComment }
  | { type: 'event'; at: number; key: string; event: TaskEvent }

export function activityFeed(comments: TaskComment[], events: TaskEvent[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [
    ...comments.map((comment): ActivityEntry => ({
      type: 'comment',
      at: comment.createdAt,
      key: `c:${comment.id}`,
      comment,
    })),
    ...events.map((event): ActivityEntry => ({
      type: 'event',
      at: event.createdAt,
      key: `e:${event.id}`,
      event,
    })),
  ]
  return entries.sort((left, right) => left.at - right.at || left.key.localeCompare(right.key))
}

/** Name the session that authored an agent comment. The durable task-session
 * link carries the indexed title; comments keep only the stable session id. */
export function commentSessionName(
  comment: Pick<TaskComment, 'originSessionId'>,
  sessions: TaskSessionLink[],
): string | null {
  if (!comment.originSessionId) return null
  const link = sessions.find((candidate) => candidate.sessionId === comment.originSessionId)
  return link
    ? sessionDisplayName({ link })
    : comment.originSessionId.slice(0, 8)
}

const ACTOR_NAMES = new Map<TaskEvent['actor'], string>([
  ['user', 'You'],
  ['agent', 'An agent'],
  ['automation', 'An automation'],
  ['system', 'Solus'],
])

const EVENT_GLYPHS = {
  plus: 'M7 2.6v8.8M2.6 7h8.8',
  arrow: 'M2.6 7h8.8M8 3.6L11.4 7 8 10.4',
  link: 'M5.8 8.2a2.2 2.2 0 003.3.2l2-2a2.2 2.2 0 00-3.1-3.1l-1.1 1.1M8.2 5.8a2.2 2.2 0 00-3.3-.2l-2 2a2.2 2.2 0 003.1 3.1l1.1-1.1',
  clock: 'M7 12.6A5.6 5.6 0 107 1.4a5.6 5.6 0 000 11.2M7 4.4V7l2 1.2',
} as const

/** One muted sentence per event, plus the glyph for its disc. */
interface TaskEventLine {
  icon: string
  text: string
}

export function eventLine(event: TaskEvent): TaskEventLine {
  const who = event.actorLabel || ACTOR_NAMES.get(event.actor) || event.actor
  const target = event.targetTitle || event.targetKey || ''
  switch (event.kind) {
    case 'created':
      return { icon: EVENT_GLYPHS.plus, text: `${who} created this task` }
    case 'status_changed':
      return {
        icon: EVENT_GLYPHS.arrow,
        text: `${who} moved this to ${statusName(event.to)}`,
      }
    case 'priority_changed':
      return { icon: EVENT_GLYPHS.arrow, text: `${who} set priority to ${event.to ?? 'none'}` }
    case 'assignee_changed':
      return { icon: EVENT_GLYPHS.arrow, text: `${who} assigned this to ${event.to ?? 'nobody'}` }
    case 'due_date_changed':
      return { icon: EVENT_GLYPHS.arrow, text: `${who} set the target to ${event.to ?? 'none'}` }
    case 'title_changed':
      return { icon: EVENT_GLYPHS.arrow, text: `${who} renamed this task` }
    case 'parent_changed':
      return { icon: EVENT_GLYPHS.arrow, text: `${who} changed the parent task` }
    case 'labels_changed':
      return { icon: EVENT_GLYPHS.arrow, text: `${who} changed the labels` }
    case 'linked':
      return { icon: EVENT_GLYPHS.link, text: `${who} linked ${target}` }
    case 'unlinked':
      return { icon: EVENT_GLYPHS.link, text: `${who} unlinked ${target}` }
    case 'session_started':
      return { icon: EVENT_GLYPHS.clock, text: 'Session started' }
    case 'snoozed':
      return {
        icon: EVENT_GLYPHS.clock,
        text: target ? `${who} snoozed this task — ${target}` : `${who} snoozed this task`,
      }
    case 'woke':
      return { icon: EVENT_GLYPHS.clock, text: `${who} woke this task` }
  }
}

function statusName(status: string | null | undefined): string {
  if (!status) return 'unknown'
  return Object.entries(STATUS_META).find(([key]) => key === status)?.[1].label ?? status
}

// ── Header ──

/** The breadcrumb's stable short name for a task. */
export function taskRef(task: Task): string {
  return task.shortId ? `T-${task.shortId}` : task.id.slice(0, 6)
}
