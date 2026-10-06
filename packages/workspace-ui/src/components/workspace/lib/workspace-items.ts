import type { WorkListing } from '../../../contexts/works/works.store.svelte'
import type { DocProviderId } from '@solus/contracts/docs'
import type { WorkReviewerSummary, WorkReviewState, WorkReviewStateEntry } from '@solus/contracts/work-review'
import { matchesOpenProjects } from '../../../lib/sessionUtils'

/** Facet type of a ledger item. Slides works fold into `doc` — the Workspace
 *  ledger distinguishes docs, diagrams, and HTML artifacts. */
export type WorkspaceItemType = 'doc' | 'diagram' | 'artifact'

/**
 * The row's leading mark. Type keys the facet; the glyph keys the artifact's
 * own identity, so the two are separate fields. Works keep the icons Solus
 * already uses for them in the project panel, slides included, even though
 * slides file under the Docs facet.
 */
export type WorkspaceGlyph = 'doc' | 'slides' | 'diagram' | 'artifact' | 'insights-report'

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
  /** The project this artifact belongs to: a known project's key, or the
   *  work's own directory when no known project claims it. */
  projectKey: string
  projectLabel: string
  /** The review state, when the work has reviewers. */
  reviewState: WorkReviewState | null
  /** Who reviews it and what they decided. */
  reviewers: WorkReviewerSummary[]
  /** A review request waits for the reader. */
  awaitingMyReview: boolean
  work: WorkListing
}

/** Structural shape of `OpenProject` — the ledger only needs identity, a label,
 *  and the path roots that attribute an artifact to it. */
export type WorkspaceProject = { key: string; label: string; roots: string[] }

/** What the ledger knows about each work's review, from the review store. */
export interface WorkReviewLookup {
  summaryOf(workId: string): WorkReviewStateEntry | undefined
  awaitsMe(workId: string): boolean
}

const NO_REVIEWS: WorkReviewLookup = { summaryOf: () => undefined, awaitsMe: () => false }

export function workItem(w: WorkListing, project: Pick<WorkspaceProject, 'key' | 'label'>, reviews: WorkReviewLookup = NO_REVIEWS): WorkspaceItem {
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
    type: w.type === 'diagram' || w.type === 'artifact' ? w.type : 'doc',
    glyph: w.type === 'doc' ? 'doc' : w.type,
    title: w.title || 'Untitled document',
    snippet: w.type === 'diagram' ? '' : w.preview,
    timestamp: updated,
    createdAt: new Date(w.createdAt).getTime() || updated,
    sessionId: origin,
    pinned: !!w.pinned,
    pinnedAt: updated,
    cwd: w.cwd,
    reviewState: review?.state ?? null,
    reviewers: review?.reviewers ?? [],
    awaitingMyReview: reviews.awaitsMe(w.id),
    work: w,
  }
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

/** The project an artifact belongs to (worktrees and subfolders count as
 *  their project). A work outside every known project files under its own
 *  directory, so the global ledger never drops it. */
function projectFor(cwd: string, projects: WorkspaceProject[]): Pick<WorkspaceProject, 'key' | 'label'> {
  const known = projects.find((p) => matchesOpenProjects(cwd, p.roots))
  if (known) return known
  const label = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return { key: cwd, label: label || 'No project' }
}

/** Every work on every host, newest first. The Workspace is global: it spans
 *  all projects, and each item names the project it came from. */
export function buildWorkspaceItems(
  works: WorkListing[],
  projects: WorkspaceProject[],
  reviews: WorkReviewLookup = NO_REVIEWS,
): WorkspaceItem[] {
  const items: WorkspaceItem[] = []
  const seenRowKeys = new Set<string>()
  for (const w of works) {
    const item = workItem(w, projectFor(w.cwd, projects), reviews)
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

const TYPE_TOKENS = new Map<string, TypeFilter>([['doc', 'doc'], ['diagram', 'diagram'], ['artifact', 'artifact']])
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

/** The Project filter's options: every project that holds a work, by name,
 *  each with its count. */
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
