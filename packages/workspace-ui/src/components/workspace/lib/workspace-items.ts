import type { WorkListing } from '../../../contexts/works/works.store.svelte'
import type { ListedSession } from '../../../contexts/workspace/session-list.store.svelte'
import type { DocProviderId } from '@solus/contracts/docs'
import type { ResourceRole, ShareSummary } from '@solus/contracts/sharing'
import type { SessionRecordStatus } from '@solus/contracts/types'
import type { WorkReviewerSummary, WorkReviewState, WorkReviewStateEntry } from '@solus/contracts/work-review'
import { projectKeyLabel } from '@solus/client-core/project-identity'

/** Facet type of a ledger item. Slides works fold into `doc` — the Workspace
 *  ledger distinguishes docs and HTML artifacts. */
export type WorkspaceItemType = 'doc' | 'artifact'

/**
 * The row's leading mark. Type keys the facet; the glyph keys the artifact's
 * own identity, so the two are separate fields. Works keep the icons Solus
 * already uses for them in the project panel, slides included, even though
 * slides file under the Docs facet.
 */
export type WorkspaceGlyph = 'doc' | 'slides' | 'artifact'

/** One row of the Workspace ledger — a work, normalized to a single shape so
 *  grouping, filtering, and keyboard nav treat every artifact identically.
 *  Plans are session artifacts and stay out of the Workspace. */
export type WorkspaceItem = {
  /** The work id. */
  id: string
  /** Renderer identity. */
  rowKey: string
  type: WorkspaceItemType
  glyph: WorkspaceGlyph
  title: string
  snippet: string
  /** Last-activity epoch ms (work updatedAt). */
  timestamp: number
  /** When the artifact was first written, epoch ms. */
  createdAt: number
  /** The session that generated it — the row links back to it. Null on a work
   *  that was created by hand rather than by an agent. */
  sessionId: string | null
  pinned: boolean
  /** Sort key inside the Pinned group (newest pin first). */
  pinnedAt: number
  cwd: string
  /** The logical project this artifact belongs to (docs/plans/project-model.md
   *  §1): its repository, with every checkout on any host, or its folder as a
   *  local-only project. */
  projectKey: string
  projectLabel: string
  /** The review state, when the work has reviewers. */
  reviewState: WorkReviewState | null
  /** Who reviews it and what they decided. */
  reviewers: WorkReviewerSummary[]
  /** A review request waits for the reader. */
  awaitingMyReview: boolean
  /** The reader's role on the work, as its host answered; null on a host that is theirs. */
  role: ResourceRole | null
  /** The person the work belongs to; null from a host older than the field. */
  ownerKey: string | null
  /** Who else may open it; null from a host older than the field. */
  share: ShareSummary | null
  work: WorkListing
}

/** What a card says of a work's sharing at a glance, with the glyph that says it. */
export interface ShareStateLabel {
  glyph: 'private' | 'people' | 'organization' | 'link'
  label: string
}

function linkTimeLeft(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return ''
  const left = expiresAt - now
  if (left <= 0) return 'expired'
  const hours = Math.round(left / 3_600_000)
  if (hours < 1) return 'under an hour left'
  if (hours < 48) return `${hours}h left`
  return `${Math.round(hours / 24)}d left`
}

/**
 * Who else may open the reader's own work, as one phrase. The widest reach
 * leads: a link reaches anyone, then the organization, then the people named.
 * Null from a host that did not say, so the card shows nothing rather than a guess.
 */
export function shareStateLabel(share: ShareSummary | null, now = Date.now()): ShareStateLabel | null {
  if (!share) return null
  if (share.link) {
    const left = linkTimeLeft(share.link.expiresAt, now)
    return { glyph: 'link', label: left ? `Anyone with link · ${left}` : 'Anyone with link' }
  }
  if (share.organization) return { glyph: 'organization', label: share.named > 0 ? `Organization · ${share.named} named` : 'Organization' }
  if (share.named > 0) return { glyph: 'people', label: `${share.named} ${share.named === 1 ? 'person' : 'people'}` }
  return { glyph: 'private', label: 'Only you' }
}

/**
 * A record another person let the reader open (docs/plans/access-model.md
 * §2.7). The reader's own record carries `owner`, or no role at all on a host
 * that is theirs; `none` is a record they cannot open and never see listed.
 */
export function isSharedWithMe(role: ResourceRole | null | undefined): boolean {
  return role != null && role !== 'owner' && role !== 'none'
}

/** The role as the share dialog names it. */
export function roleLabel(role: ResourceRole): string {
  switch (role) {
    case 'owner': return 'Owner'
    case 'editor': return 'Can edit'
    case 'commenter': return 'Can comment'
    case 'custom': return 'Custom'
    default: return 'Can view'
  }
}

/** How the ledger names projects, from the shared project model
 *  (docs/plans/project-model.md §5): the project a work belongs to, and the
 *  rows a list of projects shows, one per project with distinct names. */
export interface WorkspaceProjects {
  keyOf(work: WorkListing): string
  optionsFor(projectKeys: Iterable<string>): { key: string; label: string }[]
}

/** What the ledger knows about each work's review, from the review store. */
export interface WorkReviewLookup {
  summaryOf(workId: string): WorkReviewStateEntry | undefined
  awaitsMe(workId: string): boolean
}

const NO_REVIEWS: WorkReviewLookup = { summaryOf: () => undefined, awaitsMe: () => false }

export function workItem(w: WorkListing, project: { key: string; label: string }, reviews: WorkReviewLookup = NO_REVIEWS): WorkspaceItem {
  const updated = new Date(w.updatedAt).getTime() || 0
  // The newest collaborator is the session a reader wants to land in; the
  // legacy single `sessionId` covers works written before that list existed.
  const origin = w.sessionIds?.at(-1) ?? w.sessionId ?? null
  const review = reviews.summaryOf(w.id)
  return {
    projectKey: project.key,
    projectLabel: project.label,
    id: w.id,
    rowKey: `work:${w.id}`,
    type: w.type === 'artifact' ? w.type : 'doc',
    glyph: w.type === 'doc' ? 'doc' : w.type,
    title: w.title || 'Untitled document',
    snippet: w.preview,
    timestamp: updated,
    createdAt: new Date(w.createdAt).getTime() || updated,
    sessionId: origin,
    pinned: !!w.pinned,
    pinnedAt: updated,
    cwd: w.cwd,
    reviewState: review?.state ?? null,
    reviewers: review?.reviewers ?? [],
    awaitingMyReview: reviews.awaitsMe(w.id),
    role: w.role ?? null,
    ownerKey: w.ownerKey ?? null,
    share: w.share ?? null,
    work: w,
  }
}

// ─── Tabs ───

/** The page's three groups: the reader's own works, then what others shared
 *  with them, works and live sessions apart. */
export type WorkspaceTab = 'yours' | 'shared-works' | 'shared-sessions'

export interface WorkspaceTabSpec {
  id: WorkspaceTab
  label: string
  count: number
}

export function workspaceTabs(counts: Record<WorkspaceTab, number>): WorkspaceTabSpec[] {
  return [
    { id: 'yours', label: 'Your works', count: counts.yours },
    { id: 'shared-works', label: 'Shared works', count: counts['shared-works'] },
    { id: 'shared-sessions', label: 'Shared sessions', count: counts['shared-sessions'] },
  ]
}

/** The reader's own works and the ones shared with them, apart. */
export interface WorkspaceOwnership {
  yours: WorkspaceItem[]
  shared: WorkspaceItem[]
}

export function splitByOwnership(items: WorkspaceItem[]): WorkspaceOwnership {
  const yours: WorkspaceItem[] = []
  const shared: WorkspaceItem[] = []
  for (const item of items) (isSharedWithMe(item.role) ? shared : yours).push(item)
  return { yours, shared }
}

// ─── Shared sessions ───

/** One session another person shared with the reader, as the Shared sessions
 *  tab shows it: who runs it, how far the reader may go, and whether it works now. */
export interface WorkspaceSessionItem {
  rowKey: string
  serverId: string
  sessionId: string
  title: string
  /** The project folder's last segment. */
  projectLabel: string
  branch: string | null
  status: SessionRecordStatus
  role: ResourceRole
  ownerKey: string
  /** Last activity, epoch ms. */
  timestamp: number
  runnerOffline: boolean
  listed: ListedSession
}

function lastSegment(path: string | null): string {
  if (!path) return ''
  const segments = path.split(/[/\\]/).filter(Boolean)
  return segments.at(-1) ?? path
}

/** The sessions in the reader's list that another person shared with them, newest first. */
export function buildSharedSessionItems(sessions: ListedSession[]): WorkspaceSessionItem[] {
  const items: WorkspaceSessionItem[] = []
  for (const listed of sessions) {
    if (!isSharedWithMe(listed.role) || !listed.role) continue
    items.push({
      rowKey: `session:${listed.sessionId}`,
      serverId: listed.serverId,
      sessionId: listed.sessionId,
      title: listed.title || 'Untitled session',
      projectLabel: lastSegment(listed.projectPath),
      branch: listed.branch,
      status: listed.status,
      role: listed.role,
      ownerKey: listed.ownerKey,
      timestamp: listed.lastActivityAt || listed.createdAt,
      runnerOffline: listed.runnerOffline,
      listed,
    })
  }
  items.sort((a, b) => b.timestamp - a.timestamp)
  return items
}

export function applySessionFilter(items: WorkspaceSessionItem[], text: string): WorkspaceSessionItem[] {
  const q = text.trim().toLowerCase()
  if (!q) return items
  return items.filter((item) => item.title.toLowerCase().includes(q) || item.projectLabel.toLowerCase().includes(q))
}

export function sortSessionItems(items: WorkspaceSessionItem[], order: SortOrder): WorkspaceSessionItem[] {
  return [...items].sort((a, b) => (order === 'oldest' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp))
}

export type SessionGroup = { key: string; label: string; items: WorkspaceSessionItem[] }

/** A session whose agent works now leads, whatever its age; the rest fall
 *  into the ledger's date buckets. */
export function groupSharedSessions(items: WorkspaceSessionItem[], now = new Date()): SessionGroup[] {
  const live: SessionGroup = { key: 'live', label: 'Live now', items: [] }
  const groups: SessionGroup[] = []
  const byKey = new Map<string, SessionGroup>()
  for (const item of items) {
    if (item.status === 'running') {
      live.items.push(item)
      continue
    }
    const bucket = bucketFor(item.timestamp, now)
    let group = byKey.get(bucket.key)
    if (!group) {
      group = { key: bucket.key, label: bucket.label, items: [] }
      byKey.set(bucket.key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return live.items.length > 0 ? [live, ...groups] : groups
}

/** What the status icon shows. */
export type RowStatusKind = 'approved' | 'changes_requested' | 'in_review' | 'review_requested'

/**
 * The status column: a work's review state, as an icon with its word for hover
 * and screen readers. A work the reader must review says so first.
 */
export function rowStatus(item: Pick<WorkspaceItem, 'reviewState' | 'awaitingMyReview'>): { kind: RowStatusKind; label: string } | null {
  if (item.awaitingMyReview) return { kind: 'review_requested', label: 'Your review is requested' }
  switch (item.reviewState) {
    case 'in_review': return { kind: 'in_review', label: 'In review' }
    case 'approved': return { kind: 'approved', label: 'Approved' }
    case 'changes_requested': return { kind: 'changes_requested', label: 'Changes requested' }
    default: return null
  }
}

/** HTML artifacts render their own interface, so a source-text peek has no
 * useful mobile representation. */
export function isHtmlArtifact(item: WorkspaceItem): boolean {
  return item.work.type === 'artifact'
}

/** The external product whose mark belongs in the Workspace upstream column. */
export function upstreamProviderFor(item: WorkspaceItem): DocProviderId | null {
  return item.work.mirroredDoc?.provider ?? null
}

/** Every work on every host, newest first. The Workspace is global: it spans
 *  all projects, and each item names the project it came from — by the name
 *  every other project list gives it, so two projects never share one. */
export function buildWorkspaceItems(
  works: WorkListing[],
  projects: WorkspaceProjects,
  reviews: WorkReviewLookup = NO_REVIEWS,
): WorkspaceItem[] {
  const keys = works.map((w) => projects.keyOf(w))
  const labels = new Map(projects.optionsFor(keys).map((option) => [option.key, option.label]))
  const items: WorkspaceItem[] = []
  const seenRowKeys = new Set<string>()
  for (const [index, w] of works.entries()) {
    const key = keys[index]!
    const item = workItem(w, { key, label: labels.get(key) || projectKeyLabel(key) || 'No project' }, reviews)
    if (seenRowKeys.has(item.rowKey)) continue
    seenRowKeys.add(item.rowKey)
    items.push(item)
  }
  items.sort((a, b) => b.timestamp - a.timestamp)
  return items
}

// ─── Grouping ───

export type LedgerBucketKey = 'today' | 'yesterday' | 'week' | string

export interface LedgerBucket {
  key: LedgerBucketKey
  label: string
}

/** Ledger buckets per the spec: Today, Yesterday, This week, then one bucket
 *  per calendar month ("July", or "July 2025" once the year differs). */
export function bucketFor(timestamp: number, now = new Date()): LedgerBucket {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay()
  const startOfWeek = startOfToday - (dayOfWeek - 1) * 86_400_000

  if (timestamp >= startOfToday) return { key: 'today', label: 'Today' }
  if (timestamp >= startOfYesterday) return { key: 'yesterday', label: 'Yesterday' }
  if (timestamp >= startOfWeek) return { key: 'week', label: 'This week' }

  const date = new Date(timestamp)
  const month = date.toLocaleDateString(undefined, { month: 'long' })
  const label = date.getFullYear() === now.getFullYear() ? month : `${month} ${date.getFullYear()}`
  return { key: `${date.getFullYear()}-${date.getMonth()}`, label }
}

export type LedgerGroup = { key: string; label: string; items: WorkspaceItem[] }

/** The shared works: what waits on the reader first, then the date buckets.
 *  A pin is the reader's own mark, and it keeps its place inside the buckets:
 *  the only group that cuts across time here is the one that needs them. */
export function groupSharedWorks(items: WorkspaceItem[], now = new Date()): LedgerGroup[] {
  const needsYou: LedgerGroup = { key: 'needs-you', label: 'Needs you', items: [] }
  const groups: LedgerGroup[] = []
  const byKey = new Map<string, LedgerGroup>()
  for (const item of items) {
    if (item.awaitingMyReview) {
      needsYou.items.push(item)
      continue
    }
    const bucket = bucketFor(item.timestamp, now)
    let group = byKey.get(bucket.key)
    if (!group) {
      group = { key: bucket.key, label: bucket.label, items: [] }
      byKey.set(bucket.key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return needsYou.items.length > 0 ? [needsYou, ...groups] : groups
}

export interface GroupedWorkspaceItems {
  pinned: WorkspaceItem[]
  groups: LedgerGroup[]
}

/** Split into the Pinned group plus date buckets. A pinned item is *moved* into
 *  Pinned — it never appears twice. */
export function groupItems(items: WorkspaceItem[]): GroupedWorkspaceItems {
  const pinned = items.filter((i) => i.pinned).sort((a, b) => b.pinnedAt - a.pinnedAt)
  const groups: LedgerGroup[] = []
  const byKey = new Map<string, LedgerGroup>()
  const now = new Date()
  for (const item of items) {
    if (item.pinned) continue
    const bucket = bucketFor(item.timestamp, now)
    let group = byKey.get(bucket.key)
    if (!group) {
      group = { key: bucket.key, label: bucket.label, items: [] }
      byKey.set(bucket.key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return { pinned, groups }
}

// ─── Sorting ───

/** The ledger's one sort axis. `recent` is the default the filter bar names. */
export type SortOrder = 'recent' | 'oldest'

/** Order the ledger. Group order follows from item order — `groupItems` emits
 *  buckets in first-seen order — so oldest-first reverses the date buckets too,
 *  which is what a reader asking for the oldest work expects to see first. */
export function sortItems(items: WorkspaceItem[], order: SortOrder): WorkspaceItem[] {
  return [...items].sort((a, b) =>
    order === 'oldest' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp,
  )
}

// ─── Filtering + search tokens ───

export type TypeFilter = 'all' | WorkspaceItemType
export type TimeFilter = 'all' | 'today' | 'yesterday' | 'week' | 'older'

export type WorkspaceFilter = {
  type: TypeFilter
  pinnedOnly: boolean
  /** Only works whose review request waits for the reader. */
  awaitingMyReview: boolean
  time: TimeFilter
  /** A project key, or empty for every project. Page-local: it never moves
   *  the scope Tasks, Pull requests, or Automations share. */
  project: string
  /** Free text — matched against title + snippet, case-insensitive. */
  text: string
}

export const DEFAULT_FILTER: WorkspaceFilter = {
  type: 'all',
  pinnedOnly: false,
  awaitingMyReview: false,
  time: 'all',
  project: '',
  text: '',
}

export function isDefaultFilter(f: WorkspaceFilter): boolean {
  return f.type === 'all' && !f.pinnedOnly && !f.awaitingMyReview && f.time === 'all' && !f.project && !f.text.trim()
}

const TYPE_TOKENS = new Map<string, TypeFilter>([['doc', 'doc'], ['artifact', 'artifact']])
const TIME_TOKENS = new Map<string, TimeFilter>([['today', 'today'], ['yesterday', 'yesterday'], ['week', 'week'], ['older', 'older']])

/** Parse one `key:value` word into a filter patch, or null when it isn't a
 *  recognized token (it stays free text). */
export function parseToken(word: string): Partial<WorkspaceFilter> | null {
  const match = /^(type|is|time):(\S+)$/i.exec(word)
  if (!match) return null
  const key = match[1].toLowerCase()
  const value = match[2].toLowerCase()
  const type = TYPE_TOKENS.get(value)
  if (key === 'type' && type) return { type }
  if (key === 'is' && value === 'pinned') return { pinnedOnly: true }
  if (key === 'is' && value === 'review-requested') return { awaitingMyReview: true }
  const time = TIME_TOKENS.get(value)
  if (key === 'time' && time) return { time }
  return null
}

function inTimeBucket(timestamp: number, time: TimeFilter, now: Date): boolean {
  if (time === 'all') return true
  const bucket = bucketFor(timestamp, now)
  if (time === 'older') return bucket.key !== 'today' && bucket.key !== 'yesterday' && bucket.key !== 'week'
  return bucket.key === time
}

export function applyFilter(items: WorkspaceItem[], filter: WorkspaceFilter): WorkspaceItem[] {
  const q = filter.text.trim().toLowerCase()
  const now = new Date()
  return items.filter((item) => {
    if (filter.type !== 'all' && item.type !== filter.type) return false
    if (filter.pinnedOnly && !item.pinned) return false
    if (filter.awaitingMyReview && !item.awaitingMyReview) return false
    if (!inTimeBucket(item.timestamp, filter.time, now)) return false
    if (filter.project && item.projectKey !== filter.project) return false
    if (!q) return true
    return item.title.toLowerCase().includes(q) || item.snippet.toLowerCase().includes(q)
  })
}

/** The Project filter's options: every project that holds a work, by the
 *  name its rows show, each with its count. */
export function projectOptions(items: WorkspaceItem[]): { value: string; label: string; count: number }[] {
  const byKey = new Map<string, { value: string; label: string; count: number }>()
  for (const item of items) {
    const option = byKey.get(item.projectKey)
    if (option) option.count++
    else byKey.set(item.projectKey, { value: item.projectKey, label: item.projectLabel, count: 1 })
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export type FilterChip = { key: 'type' | 'pinned' | 'review' | 'time'; token: string }

/** The active non-default filter axes, as removable `key:value` chips. */
export function filterChips(filter: WorkspaceFilter): FilterChip[] {
  const chips: FilterChip[] = []
  if (filter.type !== 'all') chips.push({ key: 'type', token: `type:${filter.type}` })
  if (filter.pinnedOnly) chips.push({ key: 'pinned', token: 'is:pinned' })
  if (filter.awaitingMyReview) chips.push({ key: 'review', token: 'is:review-requested' })
  if (filter.time !== 'all') chips.push({ key: 'time', token: `time:${filter.time}` })
  return chips
}

export function clearChip(filter: WorkspaceFilter, key: FilterChip['key']): void {
  if (key === 'type') filter.type = 'all'
  if (key === 'pinned') filter.pinnedOnly = false
  if (key === 'review') filter.awaitingMyReview = false
  if (key === 'time') filter.time = 'all'
}

// ─── Formatting ───

/** Ledger time column: relative under 7 days (50m, 8h, 3d), then "Jul 15". */
export function formatLedgerTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The row's generated column: the calendar date the artifact was written,
 *  absolute so it never reads as a second copy of the relative activity time.
 *  The year appears only once it stops being this one. */
export function formatGeneratedDate(timestamp: number, now = new Date()): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const sameYear = date.getFullYear() === now.getFullYear()
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
  }
  if (!sameYear) options.year = 'numeric'
  return date.toLocaleDateString(undefined, options)
}

/** The tooltip behind that column — the full moment, since the column itself is
 *  deliberately coarse. */
export function formatGeneratedFull(timestamp: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** The peek's age line: "50m ago" while the ledger time is relative, and the
 *  bare date once it has crossed into "Jul 15". */
export function formatPeekAge(timestamp: number): string {
  const time = formatLedgerTime(timestamp)
  return /^\d/.test(time) ? `${time} ago` : time
}
