// Pure, non-reactive helpers for the tasks UI.
import type { Task, TaskStatus, TaskPriority } from '../../../../shared/task-types'

export type StatusFilter = 'all' | 'active' | 'open' | 'in_progress' | 'done'

/** How the list/board orders tasks. `updated` is the provider default;
 *  `priority` and `due` answer "what's next". */
export type TaskSort = 'updated' | 'priority' | 'due'

export interface TaskFilterState {
  query: string
  status: StatusFilter
  sort: TaskSort
}

/** Display + ordering metadata per priority. `rank` drives the sort (lower =
 *  more urgent); the colour classes drive the badge. */
// Classes are full literals (no runtime string-building) so Tailwind's scanner
// emits them. `chipClass` = badge bg+text, `flagClass` = icon text colour.
// Each colour pairs a darker light-mode value with a brighter dark-mode one —
// the dark-palette hexes alone fall below readable contrast on light surfaces.
export const PRIORITY_META: Record<
  TaskPriority,
  { label: string; rank: number; chipClass: string; flagClass: string }
> = {
  urgent: { label: 'Urgent', rank: 0, chipClass: 'text-[#cf222e] bg-[#cf222e]/10 [.dark_&]:text-[#f85149] [.dark_&]:bg-[#f85149]/10', flagClass: 'text-[#cf222e] [.dark_&]:text-[#f85149]' },
  high: { label: 'High', rank: 1, chipClass: 'text-[#bc4c00] bg-[#bc4c00]/10 [.dark_&]:text-[#db6d28] [.dark_&]:bg-[#db6d28]/10', flagClass: 'text-[#bc4c00] [.dark_&]:text-[#db6d28]' },
  medium: { label: 'Medium', rank: 2, chipClass: 'text-[#9a6700] bg-[#9a6700]/10 [.dark_&]:text-[#d29922] [.dark_&]:bg-[#d29922]/10', flagClass: 'text-[#9a6700] [.dark_&]:text-[#d29922]' },
  low: { label: 'Low', rank: 3, chipClass: 'text-(--solus-text-tertiary) bg-(--solus-surface-hover)', flagClass: 'text-(--solus-text-tertiary)' },
}

/** Due-date tone classes, paired light/dark like PRIORITY_META. `chip` is the
 *  badge form (cards), `text` the inline form (detail sidebar). */
export const DUE_TONE_META = {
  overdue: {
    chip: 'text-[#cf222e] bg-[#cf222e]/10 [.dark_&]:text-[#f85149] [.dark_&]:bg-[#f85149]/10',
    text: 'text-[#cf222e] [.dark_&]:text-[#f85149]',
  },
  soon: {
    chip: 'text-[#9a6700] bg-[#9a6700]/10 [.dark_&]:text-[#d29922] [.dark_&]:bg-[#d29922]/10',
    text: 'text-[#9a6700] [.dark_&]:text-[#d29922]',
  },
  normal: {
    chip: 'text-(--solus-text-tertiary) bg-(--solus-surface-hover)',
    text: 'text-(--solus-text-tertiary)',
  },
} as const

function priorityRank(t: Task): number {
  return t.priority ? PRIORITY_META[t.priority].rank : 4
}

function dueRank(t: Task): number {
  if (!t.dueDate) return Number.POSITIVE_INFINITY
  const ms = Date.parse(`${t.dueDate}T00:00:00`)
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
}

/** Order tasks for display. Priority/due both tie-break by the other then by
 *  recency, so "what's next" surfaces urgent + soon-due work first. */
export function sortTasks(tasks: Task[], sort: TaskSort): Task[] {
  const byUpdated = (a: Task, b: Task) => b.updatedAt.localeCompare(a.updatedAt)
  const arr = [...tasks]
  if (sort === 'priority') {
    arr.sort((a, b) => priorityRank(a) - priorityRank(b) || dueRank(a) - dueRank(b) || byUpdated(a, b))
  } else if (sort === 'due') {
    arr.sort((a, b) => dueRank(a) - dueRank(b) || priorityRank(a) - priorityRank(b) || byUpdated(a, b))
  } else {
    arr.sort(byUpdated)
  }
  return arr
}

/** Display metadata for a normalized status — label + the theme token its dot uses. */
export const STATUS_META: Record<TaskStatus, { label: string; dotClass: string }> = {
  open: { label: 'Open', dotClass: 'border border-(--solus-text-tertiary)' },
  in_progress: { label: 'In progress', dotClass: 'bg-(--solus-accent)' },
  done: { label: 'Done', dotClass: 'bg-(--solus-text-secondary)' },
}

export function statusLabel(status: TaskStatus): string {
  return STATUS_META[status]?.label ?? status
}

// The GitHub provider maps the conventional `in-progress` label onto the
// `in_progress` status (see its IN_PROGRESS_LABEL) but keeps it in `labels`.
// Rendering it as a chip just repeats the status/column, so it's dropped.
const STATUS_REDUNDANT_LABELS = new Set(['in-progress', 'in progress'])

/** A task's labels minus those already conveyed by its status, so a card never
 *  shows a chip that duplicates its column (e.g. "in-progress" in In progress). */
export function visibleLabels(task: Task): string[] {
  return task.labels.filter((l) => !STATUS_REDUNDANT_LABELS.has(l.trim().toLowerCase()))
}

export interface TaskComment {
  author: { login: string } | null
  body: string
  createdAt: string
}

/** Up-to-two-letter initials for a comment author's avatar. Splits on the usual
 *  name separators (space, dot, underscore, dash) so `ashton.sidhu` → "AS";
 *  falls back to the first two characters, or "?" when there's no author. */
export function authorInitials(login: string | null | undefined): string {
  const name = (login ?? '').trim()
  if (!name) return '?'
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export interface TaskLinkedPr {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
}

/** Pull the hydrated comments + linked PRs out of a GitHub task's `raw` payload
 *  (shaped by the GitHub provider's `GitHubTaskRaw`). Returns empty lists for
 *  local tasks or an unhydrated summary, so the detail view degrades cleanly. */
export function taskHydration(task: Task): { comments: TaskComment[]; linkedPrs: TaskLinkedPr[] } {
  const raw = task.raw
  if (raw && typeof raw === 'object' && 'comments' in raw) {
    const r = raw as { comments?: TaskComment[]; linkedPrs?: TaskLinkedPr[] }
    return { comments: r.comments ?? [], linkedPrs: r.linkedPrs ?? [] }
  }
  return { comments: [], linkedPrs: [] }
}

/** Compact "updated 5m ago" style relative time for the freshness hint and
 *  comment timestamps. Falls back to the raw string if it won't parse. Pass
 *  `now` from a ticking $state so the label re-renders as time passes. */
export function relativeTime(iso: string | number, now = Date.now()): string {
  const then = typeof iso === 'number' ? iso : Date.parse(iso)
  if (Number.isNaN(then)) return String(iso)
  const secs = Math.round((now - then) / 1000)
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

/** Compact "Jun 25" calendar label for the board card footer. Falls back to the
 *  raw string if it won't parse so the footer never renders garbage. */
export function shortDate(iso: string | number): string {
  const then = typeof iso === 'number' ? iso : Date.parse(iso)
  if (Number.isNaN(then)) return String(iso)
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The kanban columns, in board order. Status is the drop target / drag result. */
export const BOARD_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'done', label: 'Done' },
]

/** Presentation for a task's due date: a compact label plus a tone the card uses
 *  to colour it. `overdue` = before today (and not done elsewhere), `soon` =
 *  today or tomorrow, else `normal`. Returns null when no due date is set. */
export function dueDateMeta(
  dueDate: string | undefined,
): { label: string; tone: 'overdue' | 'soon' | 'normal' } | null {
  if (!dueDate) return null
  const due = Date.parse(`${dueDate}T00:00:00`)
  if (Number.isNaN(due)) return null
  const now = new Date()
  const today = Date.parse(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T00:00:00`,
  )
  const days = Math.round((due - today) / 86_400_000)
  const tone = days < 0 ? 'overdue' : days <= 1 ? 'soon' : 'normal'
  const label =
    days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday'
      : days < 0 ? `${-days}d overdue`
      : new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return { label, tone }
}

export interface TaskGroup {
  /** The epic task, or null for the bucket of tasks that belong to no epic. */
  epic: Task | null
  children: Task[]
}

export interface BoardColumn {
  status: TaskStatus
  label: string
  tasks: Task[]
}

/**
 * Bucket tasks into the kanban columns by status. The column *is* the status, so
 * the status filter doesn't apply here — only the free-text query (and the
 * server-side assignee scope already baked into `tasks`). Epics are containers,
 * not board cards, so they're dropped; their children stand on their own.
 */
export function buildBoard(tasks: Task[], query: string, sort: TaskSort): BoardColumn[] {
  const q = query.trim().toLowerCase()
  const leaves = tasks.filter((t) => t.kind !== 'epic' && matchesQuery(t, q))
  return BOARD_COLUMNS.map((col) => ({
    ...col,
    tasks: sortTasks(leaves.filter((t) => t.status === col.status), sort),
  }))
}

function matchesQuery(task: Task, q: string): boolean {
  if (!q) return true
  return [task.title, task.body, task.assignee ?? '', task.id, ...task.labels]
    .join('\n')
    .toLowerCase()
    .includes(q)
}

function matchesStatus(task: Task, status: StatusFilter): boolean {
  if (status === 'all') return true
  if (status === 'active') return task.status === 'open' || task.status === 'in_progress'
  return task.status === status
}

/**
 * Build the epic-grouped, filtered view. Epics are containers, not
 * leaves: the status filter applies to their children, never to the epic itself,
 * and an epic is hidden once a filter/search empties it (the old code left bare
 * epic headers behind). A search hit on an epic's own title keeps the epic with
 * its status-matching children. With no filter or query, every epic shows — even
 * empty ones, so you can still add to them.
 */
export function buildTaskGroups(tasks: Task[], filters: TaskFilterState): TaskGroup[] {
  const q = filters.query.trim().toLowerCase()
  const active = filters.status !== 'all' || q.length > 0
  const epics: Task[] = []
  for (const task of tasks) {
    if (task.kind === 'epic') epics.push(task)
  }

  const epicIds = new Set(epics.map((e) => e.id))
  const childrenByEpic = new Map<string, Task[]>()
  const standalone: Task[] = []

  for (const task of tasks) {
    if (task.kind === 'epic') continue

    if (task.parentId && epicIds.has(task.parentId)) {
      const children = childrenByEpic.get(task.parentId) ?? []
      children.push(task)
      childrenByEpic.set(task.parentId, children)
    } else {
      standalone.push(task)
    }
  }

  const groups: TaskGroup[] = []
  for (const epic of epics) {
    const epicTitleHit = q.length > 0 && epic.title.toLowerCase().includes(q)
    const children = (childrenByEpic.get(epic.id) ?? []).filter(
      (t) =>
        matchesStatus(t, filters.status) && (epicTitleHit || matchesQuery(t, q)),
    )
    if (children.length || epicTitleHit || !active) groups.push({ epic, children: sortTasks(children, filters.sort) })
  }

  const visibleStandalone = standalone.filter((t) => matchesStatus(t, filters.status) && matchesQuery(t, q))
  if (visibleStandalone.length) groups.push({ epic: null, children: sortTasks(visibleStandalone, filters.sort) })
  return groups
}
