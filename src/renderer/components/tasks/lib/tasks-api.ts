// Pure, non-reactive helpers for the tasks UI.
import type { Task, TaskStatus, TaskPriority } from '../../../../shared/task-types'

/** How the list/board orders tasks. `updated` is the default;
 *  `priority` and `due` answer "what's next". */
export type TaskSort = 'updated' | 'priority' | 'due'

/** Display + ordering metadata per priority. `rank` drives the sort (lower =
 *  more urgent); the colour classes drive the badge. */
// Classes are full literals (no runtime string-building) so Tailwind's scanner
// emits them. `chipClass` = badge bg+text, `flagClass` = icon text colour.
// Each colour pairs a darker light-mode value with a brighter dark-mode one —
// the dark-palette hexes alone fall below readable contrast on light surfaces.
interface PriorityMeta {
  label: string
  rank: number
  chipClass: string
  flagClass: string
}

export const PRIORITY_META = {
  urgent: { label: 'Urgent', rank: 0, chipClass: 'text-[#cf222e] bg-[#cf222e]/10 [.dark_&]:text-[#f85149] [.dark_&]:bg-[#f85149]/10', flagClass: 'text-[#cf222e] [.dark_&]:text-[#f85149]' },
  high: { label: 'High', rank: 1, chipClass: 'text-[#bc4c00] bg-[#bc4c00]/10 [.dark_&]:text-[#db6d28] [.dark_&]:bg-[#db6d28]/10', flagClass: 'text-[#bc4c00] [.dark_&]:text-[#db6d28]' },
  medium: { label: 'Medium', rank: 2, chipClass: 'text-[#9a6700] bg-[#9a6700]/10 [.dark_&]:text-[#d29922] [.dark_&]:bg-[#d29922]/10', flagClass: 'text-[#9a6700] [.dark_&]:text-[#d29922]' },
  low: { label: 'Low', rank: 3, chipClass: 'text-(--solus-text-tertiary) bg-(--solus-surface-hover)', flagClass: 'text-(--solus-text-tertiary)' },
} satisfies Record<TaskPriority, PriorityMeta>

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
  const byUpdated = (a: Task, b: Task) => b.updatedAt - a.updatedAt
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

// Status glyphs, drawn on a 14×14 box with a 1.45 stroke. Status is never
// carried by colour alone: each state has a distinct shape as well as a token.
const RING = 'M7 12.6A5.6 5.6 0 107 1.4a5.6 5.6 0 000 11.2'
const STATUS_GLYPHS = {
  idle: RING,
  clock: `${RING}M7 4.2v2.9l2 1.2`,
  eye: 'M1.9 7s2-3.5 5.1-3.5S12.1 7 12.1 7s-2 3.5-5.1 3.5S1.9 7 1.9 7M5.7 7a1.3 1.3 0 102.6 0 1.3 1.3 0 10-2.6 0',
  check: `${RING}M4.6 7.2l1.7 1.7L9.6 5.6`,
  slash: `${RING}M3 3l8 8`,
} as const

/** Display metadata for a normalized status — label, the theme token its dot
 *  and glyph use, the dot class, and the SVG path for the glyph form. */
interface StatusMeta {
  label: string
  dotClass: string
  token: string
  glyph: string
}

export const STATUS_META = {
  inbox: { label: 'Inbox', dotClass: 'border border-(--solus-text-tertiary)', token: '--idle', glyph: STATUS_GLYPHS.idle },
  todo: { label: 'To do', dotClass: 'border border-(--solus-text-tertiary)', token: '--idle', glyph: STATUS_GLYPHS.idle },
  in_progress: { label: 'In progress', dotClass: 'bg-(--running)', token: '--running', glyph: STATUS_GLYPHS.clock },
  in_review: { label: 'In review', dotClass: 'bg-(--review)', token: '--review', glyph: STATUS_GLYPHS.eye },
  done: { label: 'Done', dotClass: 'bg-(--success)', token: '--success', glyph: STATUS_GLYPHS.check },
  dropped: { label: 'Dropped', dotClass: 'bg-(--idle)', token: '--idle', glyph: STATUS_GLYPHS.slash },
} satisfies Record<TaskStatus, StatusMeta>

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

/** Compact "updated 5m ago" style relative time for the freshness hint and
 *  comment timestamps. Falls back to the raw string if it won't parse. Pass
 *  `now` from a ticking $state so the label re-renders as time passes. */
export function relativeTime(iso: string | number, now = Date.now()): string {
  const then = Number.isFinite(iso) ? Number(iso) : Date.parse(String(iso))
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

/**
 * The kanban columns, in board order. Status is the drop target / drag result.
 *
 * Ordered by how much attention the column wants, matching the section order of
 * the grouped list — so switching layouts re-plots the same tasks rather than
 * re-teaching where they live.
 */
export const BOARD_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'in_progress', label: 'In progress' },
  { status: 'in_review', label: 'In review' },
  { status: 'todo', label: 'Todo' },
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

interface BoardColumn {
  status: TaskStatus
  label: string
  tasks: Task[]
}

/**
 * Bucket tasks into the kanban columns by status. `tasks` arrives already
 * searched, filtered and ordered by the page, so the board is the *same* set as
 * the list re-plotted — a card can never appear in one layout and not the other.
 * Epics are containers, not board cards, so they're dropped; their children
 * stand on their own.
 */
export function buildBoard(tasks: Task[]): BoardColumn[] {
  const leaves = tasks.filter((t) => t.kind !== 'epic')
  return BOARD_COLUMNS.map((col) => ({
    ...col,
    // Every status lands somewhere, or a task would silently vanish when the
    // board is chosen: inbox is a not-yet-triaged todo, dropped is closed work.
    // Same folding the list's sections do.
    tasks: leaves.filter((task) =>
      col.status === 'todo'
        ? task.status === 'todo' || task.status === 'inbox'
        : col.status === 'done'
          ? task.status === 'done' || task.status === 'dropped'
          : task.status === col.status,
    ),
  }))
}
