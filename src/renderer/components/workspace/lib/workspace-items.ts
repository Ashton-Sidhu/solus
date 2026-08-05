import type { PlanDescriptor, Work } from '../../../../shared/types'
import { planKey } from '../../../../shared/types'
import { matchesOpenProjects } from '../../../lib/sessionUtils'

/** Facet type of a ledger item. Slides works fold into `doc` — the Workspace
 *  ledger only distinguishes the three glyphs the spec names. */
export type WorkspaceItemType = 'plan' | 'doc' | 'diagram'

export type PlanStatus = 'pending' | 'accepted' | 'rejected'

/**
 * The row's leading mark. Type keys the facet; the glyph keys the artifact's
 * own identity, so the two are separate fields. A plan wears the logo of the
 * agent that wrote it — a person scanning the ledger is usually looking for
 * "the plan Codex made", not "a plan" — and falls back to the generic plan mark
 * when the provider is unknown. Works keep the icons Solus already uses for
 * them in the project panel, slides included, even though slides file under the
 * Docs facet.
 */
export type WorkspaceGlyph = 'claude' | 'codex' | 'plan' | 'doc' | 'slides' | 'diagram'

/** One row of the Workspace ledger — a plan descriptor or a work, normalized
 *  to a single shape so grouping, filtering, and keyboard nav treat every
 *  artifact identically. */
export type WorkspaceItem = {
  /** Plan: `planKey(sessionId, planToolUseId)`. Work: the work id. */
  id: string
  type: WorkspaceItemType
  glyph: WorkspaceGlyph
  title: string
  snippet: string
  /** Last-activity epoch ms (plan timestamp / work updatedAt). */
  timestamp: number
  /** When the artifact was first written, epoch ms. Equal to `timestamp` for a
   *  plan, which is generated once and never edited in place. */
  createdAt: number
  /** The session that generated it — the row links back to it. Null on a work
   *  that was created by hand rather than by an agent. */
  sessionId: string | null
  pinned: boolean
  /** Sort key inside the Pinned group (newest pin first). */
  pinnedAt: number
  cwd: string
  /** The open project this artifact belongs to — its `OpenProject.key`. */
  projectKey: string
  projectLabel: string
  /** Plans only; docs and diagrams leave the status column blank. */
  status: PlanStatus | null
  source:
    | { kind: 'plan'; descriptor: PlanDescriptor }
    | { kind: 'work'; work: Work }
}

/** Structural shape of `OpenProject` — the ledger only needs identity, a label,
 *  and the path roots that attribute an artifact to it. */
export type WorkspaceProject = { key: string; label: string; roots: string[] }

export function planItem(d: PlanDescriptor, project: WorkspaceProject): WorkspaceItem {
  return {
    projectKey: project.key,
    projectLabel: project.label,
    id: planKey(d.sessionId, d.planToolUseId),
    type: 'plan',
    glyph: d.provider === 'claude-code' ? 'claude' : d.provider === 'codex' ? 'codex' : 'plan',
    title: d.title || 'Untitled plan',
    snippet: d.excerpt,
    timestamp: d.timestamp,
    createdAt: d.timestamp,
    sessionId: d.sessionId,
    pinned: d.bookmarked,
    pinnedAt: d.bookmarkedAt ?? d.timestamp,
    cwd: d.cwd,
    status: d.status,
    source: { kind: 'plan', descriptor: d },
  }
}

export function workItem(w: Work, project: WorkspaceProject): WorkspaceItem {
  const updated = new Date(w.updatedAt).getTime() || 0
  // The newest collaborator is the session a reader wants to land in; the
  // legacy single `sessionId` covers works written before that list existed.
  const origin = w.sessionIds?.at(-1) ?? w.sessionId ?? null
  return {
    projectKey: project.key,
    projectLabel: project.label,
    id: w.id,
    type: w.type === 'diagram' ? 'diagram' : 'doc',
    glyph: w.type === 'diagram' ? 'diagram' : w.type === 'slides' ? 'slides' : 'doc',
    title: w.title || 'Untitled document',
    snippet: w.type === 'diagram' ? '' : w.preview,
    timestamp: updated,
    createdAt: new Date(w.createdAt).getTime() || updated,
    sessionId: origin,
    pinned: !!w.pinned,
    pinnedAt: updated,
    cwd: w.cwd,
    status: null,
    source: { kind: 'work', work: w },
  }
}

/** The open project an artifact belongs to, or null when it sits outside every
 *  one of them (worktrees and subfolders count as their project). */
function projectFor(cwd: string | undefined, projects: WorkspaceProject[]): WorkspaceProject | null {
  return projects.find((p) => matchesOpenProjects(cwd, p.roots)) ?? null
}

/** Merge plans + works scoped to the open projects, newest first. Each item
 *  carries the project it came from so the ledger can scope to one. */
export function buildWorkspaceItems(
  descriptors: PlanDescriptor[],
  works: Work[],
  projects: WorkspaceProject[],
): WorkspaceItem[] {
  const items: WorkspaceItem[] = []
  for (const d of descriptors) {
    const project = projectFor(d.cwd, projects)
    if (project) items.push(planItem(d, project))
  }
  for (const w of works) {
    const project = projectFor(w.cwd, projects)
    if (project) items.push(workItem(w, project))
  }
  items.sort((a, b) => b.timestamp - a.timestamp)
  return items
}

// ─── Grouping ───

export type LedgerBucketKey = 'today' | 'yesterday' | 'week' | string

/** Ledger buckets per the spec: Today, Yesterday, This week, then one bucket
 *  per calendar month ("July", or "July 2025" once the year differs). */
export function bucketFor(timestamp: number, now = new Date()): { key: LedgerBucketKey; label: string } {
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

/** Split into the Pinned group plus date buckets. A pinned item is *moved* into
 *  Pinned — it never appears twice. */
export function groupItems(items: WorkspaceItem[]): { pinned: WorkspaceItem[]; groups: LedgerGroup[] } {
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
export type StatusFilter = 'any' | PlanStatus
export type TimeFilter = 'all' | 'today' | 'yesterday' | 'week' | 'older'

export type WorkspaceFilter = {
  type: TypeFilter
  status: StatusFilter
  pinnedOnly: boolean
  time: TimeFilter
  /** Free text — matched against title + snippet, case-insensitive. */
  text: string
}

export const DEFAULT_FILTER: WorkspaceFilter = {
  type: 'all',
  status: 'any',
  pinnedOnly: false,
  time: 'all',
  text: '',
}

export function isDefaultFilter(f: WorkspaceFilter): boolean {
  return f.type === 'all' && f.status === 'any' && !f.pinnedOnly && f.time === 'all' && !f.text.trim()
}

const TYPE_TOKENS: Record<string, TypeFilter> = { plan: 'plan', doc: 'doc', diagram: 'diagram' }
const STATUS_TOKENS: Record<string, StatusFilter> = { pending: 'pending', accepted: 'accepted', rejected: 'rejected' }
const TIME_TOKENS: Record<string, TimeFilter> = { today: 'today', yesterday: 'yesterday', week: 'week', older: 'older' }

/** Parse one `key:value` word into a filter patch, or null when it isn't a
 *  recognized token (it stays free text). */
export function parseToken(word: string): Partial<WorkspaceFilter> | null {
  const match = /^(type|status|is|time):(\S+)$/i.exec(word)
  if (!match) return null
  const key = match[1].toLowerCase()
  const value = match[2].toLowerCase()
  if (key === 'type' && TYPE_TOKENS[value]) return { type: TYPE_TOKENS[value] }
  // `status:` implies plans — the only artifact carrying one — so the filter
  // predicate already excludes docs and diagrams; no explicit type: needed.
  if (key === 'status' && STATUS_TOKENS[value]) return { status: STATUS_TOKENS[value] }
  if (key === 'is' && value === 'pinned') return { pinnedOnly: true }
  if (key === 'time' && TIME_TOKENS[value]) return { time: TIME_TOKENS[value] }
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
    if (filter.status !== 'any' && item.status !== filter.status) return false
    if (filter.pinnedOnly && !item.pinned) return false
    if (!inTimeBucket(item.timestamp, filter.time, now)) return false
    if (!q) return true
    return item.title.toLowerCase().includes(q) || item.snippet.toLowerCase().includes(q)
  })
}

export type FilterChip = { key: 'type' | 'status' | 'pinned' | 'time'; token: string }

/** The active non-default filter axes, as removable `key:value` chips. */
export function filterChips(filter: WorkspaceFilter): FilterChip[] {
  const chips: FilterChip[] = []
  if (filter.type !== 'all') chips.push({ key: 'type', token: `type:${filter.type}` })
  if (filter.status !== 'any') chips.push({ key: 'status', token: `status:${filter.status}` })
  if (filter.pinnedOnly) chips.push({ key: 'pinned', token: 'is:pinned' })
  if (filter.time !== 'all') chips.push({ key: 'time', token: `time:${filter.time}` })
  return chips
}

export function clearChip(filter: WorkspaceFilter, key: FilterChip['key']): void {
  if (key === 'type') filter.type = 'all'
  if (key === 'status') filter.status = 'any'
  if (key === 'pinned') filter.pinnedOnly = false
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
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
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
