// Pure helpers for the task page. Per the renderer rules, the .svelte files
// hold markup and thin handlers; the shaping lives here.
import type {
  Task,
  TaskComment,
  TaskField,
  TaskLink,
  TaskLinkKind,
  TaskPriority,
  TaskProviderId,
  TaskSessionLink,
} from '@solus/contracts/task-types'
import type { TaskStatusCategory } from '@solus/contracts/task-sources'
import type { DocProviderId } from '@solus/contracts/docs'
import type { HostOperatingSystem, Work } from '@solus/contracts/types'
import type { Activity } from '@solus/contracts/activity'
import type { UserId } from '@solus/contracts/user'
import { sessionDisplayName } from '../../../../lib/sessionUtils'
import { attributionName } from '../../../presence/lib/actor-name'
import { providerMark, type ProviderMarkId } from '../../../insights/lib/provider'
import { CATEGORY_META, dueDateMeta, PRIORITY_META, PROVIDER_NAMES } from '../../lib/tasks-api'
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
 *
 * 72rem, not 60rem: the 308px rail, its 34px gap and the 52px gutters take
 * 446px, which at 60rem left the task itself a 514px column. At 72rem the
 * content keeps at least 706px — a readable measure for the description and
 * room for the linked and sessions tables — and the rail folds on a laptop
 * pane before it squeezes them.
 */
export const TASK_RAIL_FOLD_MAX = 72 * 16

/**
 * What the Details control states before it opens, where the rail has folded:
 * the few fields a reader looks for first, and only the ones that are set.
 * Status and priority are left out — the line above the title already shows
 * them. An empty summary leaves the control reading "Details" alone.
 */
export interface TaskDetailsSummary {
  assignee: string | null
  due: { label: string; tone: 'overdue' | 'soon' | 'normal' } | null
  /** The first label, and how many more there are: "bug +2". */
  labels: string | null
}

export function taskDetailsSummary(
  task: Pick<Task, 'assignee' | 'dueDate' | 'labels'>,
): TaskDetailsSummary {
  const [first, ...rest] = task.labels
  return {
    assignee: task.assignee?.trim() || null,
    due: dueDateMeta(task.dueDate),
    labels: first ? (rest.length ? `${first} +${rest.length}` : first) : null,
  }
}

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

/** The text colour of a status category, for a state name and its glyph. */
export function statusTextColor(category: TaskStatusCategory): string {
  return statusColor(CATEGORY_META[category].token)
}

/** The one word for a task's status: the provider's own state name. A task
 *  that no host described yet has no name, so its category speaks for it. */
export function taskStateLabel(task: Pick<Task, 'state' | 'category'>): string {
  return task.state.name || CATEGORY_META[task.category].label
}

/** The machine an attempt ran on, already resolved against the saved hosts. */
export interface TaskSessionHost {
  label: string
  /** Drawn as the host's logo. Unknown for a host that never reported it. */
  os?: HostOperatingSystem
  /** A host Solus cloud runs: drawn as a cloud, whatever its OS. */
  managed: boolean
}

export interface TaskSessionRow {
  sessionId: string
  title: string
  /** Which agent ran the attempt — the one fact that tells two attempts of the
   *  same task apart at a glance. Empty when the session is not indexed yet. */
  agent: string
  /** The agent's logo, drawn in place of its name. Null for an agent Solus
   *  has no mark for, which keeps its name. */
  agentMark: ProviderMarkId
  /** Which machine ran it. Null only when the host cannot be named at all —
   *  a link that predates the recorded host, on a task whose own host this
   *  client has not placed. The column says so rather than guessing "here". */
  host: TaskSessionHost | null
  /** Who started it, as the reader reads it ("you", "Alice", "an agent"). Null
   *  when nobody recorded it. */
  startedBy: string | null
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
  ['replay', 'Replay (dev)'],
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
  /** The reader on the task's host, so their own sessions read "you". */
  self: UserId | null = null,
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
    agentMark: providerMark(provider),
    host: host ?? null,
    startedBy: link.startedBy ? attributionName(link.startedBy, self) : null,
    date: (thisYear ? DAY : DAY_WITH_YEAR).format(started),
    dateFull: FULL.format(started),
    running,
  }
}

// ── Fields ──

const FIELD_NAMES = {
  title: 'the title',
  body: 'the description',
  labels: 'the labels',
  assignee: 'the assignee',
  priority: 'the priority',
  dueDate: 'the due date',
} satisfies Record<TaskField, string>

/**
 * Why each field editor is disabled. The provider decides which fields one
 * task takes (`Task.canWrite`): a GitHub issue takes a due date only when a
 * Project it is on has that field. An editor for another field would end in a
 * refused write, so it is disabled and says why.
 */
export function taskFieldLocks(task: {
  providerId: TaskProviderId
  canWrite(field: TaskField): boolean
}) {
  const lock = (field: TaskField): string | null => task.canWrite(field)
    ? null
    : `${PROVIDER_NAMES[task.providerId]} does not take a change of ${FIELD_NAMES[field]} for this task`
  return {
    title: lock('title'),
    body: lock('body'),
    labels: lock('labels'),
    assignee: lock('assignee'),
    priority: lock('priority'),
    dueDate: lock('dueDate'),
  } satisfies Record<TaskField, string | null>
}

/** For each field: null when the provider takes a change of it for this task,
 *  else the sentence its disabled editor shows. */
export type TaskFieldLocks = ReturnType<typeof taskFieldLocks>

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
  workFor: (workId: string) => Pick<Work, 'mirroredDoc'> | undefined,
): DocProviderId | null {
  return link.kind === 'work' ? workFor(link.targetKey)?.mirroredDoc?.provider ?? null : null
}

export interface LinkRow {
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

export interface LinkGroup {
  kind: TaskLinkKind
  /** The plural kind name, which the wide table carries as a Kind column. */
  label: string
  rows: LinkRow[]
}

/** The Linked table's Kind column, turned into a group header.
 *
 *  A phone row has no width for a third column, and the kind is the one field
 *  that repeats — so it is hoisted out of the row and stated once above the
 *  rows that share it. The order is the table's own, so a reader who knows the
 *  wide page finds the same kinds in the same sequence. */
export function linkGroups(links: TaskLink[]): LinkGroup[] {
  const groups: LinkGroup[] = []
  for (const kind of LINK_KIND_ORDER) {
    const rows = links.filter((link) => link.kind === kind).map((link) => linkRow(link))
    if (rows.length) {
      groups.push({ kind, label: LINK_KIND_LABELS.get(kind)?.many ?? kind, rows })
    }
  }
  return groups
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

/** The feed is comments and the task's activity merged by time. Comments have
 *  no mirrored activity — their `comment_threads` rows are already that log — so the merge
 *  happens here. */
type ActivityEntry =
  | { type: 'comment'; at: number; key: string; comment: TaskComment }
  | { type: 'activity'; at: number; key: string; activity: Activity }

export function activityFeed(comments: TaskComment[], activity: Activity[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [
    ...comments.map((comment): ActivityEntry => ({
      type: 'comment',
      at: comment.createdAt,
      key: `c:${comment.id}`,
      comment,
    })),
    ...activity.map((entry): ActivityEntry => ({
      type: 'activity',
      at: entry.at,
      key: `a:${entry.id}`,
      activity: entry,
    })),
  ]
  return entries.sort((left, right) => left.at - right.at || left.key.localeCompare(right.key))
}

/** The artifact a `linked` change brought onto the task, or null for any other
 *  activity. The feed shows a render where it was linked, collapsed, so the
 *  reader finds it in the story of the task and not only in the Linked table.
 *  Read against the live links: a change for a work since unlinked, or one
 *  that is a document, gets no card. */
export function linkedArtifactForActivity(activity: Activity, links: TaskLink[]): TaskLink | null {
  if (activity.kind !== 'task_changed' || activity.change !== 'linked' || activity.target?.kind !== 'work') return null
  const targetKey = activity.target.key
  if (!targetKey) return null
  const link = links.find((candidate) => candidate.kind === 'work' && candidate.targetKey === targetKey)
  return link && isArtifactLink(link) ? link : null
}

/** The task's link to the session that authored an agent comment. A comment
 * keeps the id the agent knew itself by, which is the provider thread when the
 * link holds the stable Solus id, so either id finds the link. */
export function commentSessionLink(
  comment: Pick<TaskComment, 'originSessionId'>,
  sessions: TaskSessionLink[],
): TaskSessionLink | null {
  const origin = comment.originSessionId
  if (!origin) return null
  return sessions.find((candidate) => candidate.sessionId === origin || candidate.agentSessionId === origin) ?? null
}

/** Name the session that authored an agent comment. The durable task-session
 * link carries the indexed title; with no link, only the id is known. */
export function commentSessionName(
  comment: Pick<TaskComment, 'originSessionId'>,
  sessions: TaskSessionLink[],
): string | null {
  if (!comment.originSessionId) return null
  const link = commentSessionLink(comment, sessions)
  return link
    ? sessionDisplayName({ link })
    : comment.originSessionId.slice(0, 8)
}

/** Whether a comment is on the provider. An unsent comment stays on this host
 *  with the reason, and the reader sends it again or discards it. */
export type TaskCommentDelivery =
  | { state: 'sent' }
  | { state: 'unsent'; error: string }

export function commentDelivery(comment: Pick<TaskComment, 'unsent' | 'sendError'>): TaskCommentDelivery {
  if (!comment.unsent) return { state: 'sent' }
  return { state: 'unsent', error: comment.sendError?.trim() || 'The provider did not take this comment.' }
}

/** Who wrote a comment: "You" for the reader, a person's name, an agent for
 *  its person, or the provider's name for a comment that Solus only read. */
export function commentAuthorName(
  comment: Pick<TaskComment, 'author' | 'externalAuthor'>,
  self: UserId | null,
): string {
  if (!comment.author) return comment.externalAuthor?.trim() || 'Unknown'
  const name = attributionName(comment.author, self)
  return name.charAt(0).toUpperCase() + name.slice(1)
}
