// Pure, non-reactive helpers for the tasks UI.
import type {
  Task,
  TaskColumn,
  TaskMoveTarget,
  TaskPriority,
  TaskProviderId,
  TaskSourceState,
} from '@solus/contracts/task-types'
import type { TaskStatusCategory } from '@solus/contracts/task-sources'

/** How the list/board orders tasks. `created` is the default;
 *  `priority` and `due` answer "what's next". */
export type TaskSort = 'created' | 'updated' | 'priority' | 'due'
export const DEFAULT_TASK_SORT: TaskSort = 'created'

/** The sort menu's choices, in the order it shows them. */
export const TASK_SORT_OPTIONS: { value: TaskSort; label: string }[] = [
  { value: 'created', label: 'Created' },
  { value: 'updated', label: 'Updated' },
  { value: 'priority', label: 'Priority' },
  { value: 'due', label: 'Due' },
]

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

type SortableTask = Pick<Task, 'priority' | 'dueDate' | 'updatedAt' | 'createdAt'>

function priorityRank(t: SortableTask): number {
  return t.priority ? PRIORITY_META[t.priority].rank : 4
}

function dueRank(t: SortableTask): number {
  if (!t.dueDate) return Number.POSITIVE_INFINITY
  const ms = Date.parse(`${t.dueDate}T00:00:00`)
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
}

/** Order tasks for display. Priority/due both tie-break by the other then by
 *  recency, so "what's next" surfaces urgent + soon-due work first. */
export function sortTasks<T extends SortableTask>(tasks: readonly T[], sort: TaskSort): T[] {
  const byUpdated = (a: T, b: T) => b.updatedAt - a.updatedAt
  const byCreated = (a: T, b: T) =>
    (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt)
  const arr = [...tasks]
  if (sort === 'priority') {
    arr.sort((a, b) => priorityRank(a) - priorityRank(b) || dueRank(a) - dueRank(b) || byUpdated(a, b))
  } else if (sort === 'due') {
    arr.sort((a, b) => dueRank(a) - dueRank(b) || priorityRank(a) - priorityRank(b) || byUpdated(a, b))
  } else if (sort === 'created') {
    arr.sort(byCreated)
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

/** Display metadata for a status category — label, the theme token its dot
 *  and glyph use, the dot class, and the SVG path for the glyph form. */
interface CategoryMeta {
  label: string
  dotClass: string
  token: string
  glyph: string
}

export const CATEGORY_META = {
  open: { label: 'Open', dotClass: 'border border-(--solus-text-tertiary)', token: '--idle', glyph: STATUS_GLYPHS.idle },
  active: { label: 'Active', dotClass: 'bg-(--running)', token: '--running', glyph: STATUS_GLYPHS.clock },
  done: { label: 'Done', dotClass: 'bg-(--success)', token: '--success', glyph: STATUS_GLYPHS.check },
} satisfies Record<TaskStatusCategory, CategoryMeta>

/** The three status categories, in the order a view that mixes sources shows them. */
export const TASK_CATEGORIES: TaskStatusCategory[] = ['open', 'active', 'done']

/** Every priority a person can set, most urgent first. Unset is offered as
 *  "No priority" by the menus rather than living in this list, because it is
 *  the absence of one. */
export const PRIORITY_OPTIONS: TaskPriority[] = ['urgent', 'high', 'medium', 'low']

export const PROVIDER_NAMES = {
  github: 'GitHub',
  jira: 'Jira',
} satisfies Record<TaskProviderId, string>

/**
 * A task as a row names it: `#123` for a GitHub issue, `PROJ-12` for a Jira
 * issue, `Draft` for a GitHub Project item that is not an issue yet.
 *
 * The repository of a GitHub issue is left out: a row has a narrow cell, and
 * the full reference (`owner/repo#123`) is the cell's title.
 */
export function taskRef(task: Pick<Task, 'reference' | 'kind'>): string {
  if (!task.reference) return task.kind === 'draft' ? 'Draft' : ''
  const hash = task.reference.lastIndexOf('#')
  return hash > 0 ? task.reference.slice(hash) : task.reference
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

/** Three 64px controls under a compact task row: one for each status category. */
export const TASK_CATEGORY_SWIPE_REVEAL_WIDTH = TASK_CATEGORIES.length * 64

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

// ── The board ──

/** What the Tasks page plots: the columns of one task source, or every source
 *  of the project grouped by status category. */
export type BoardView =
  | { kind: 'all' }
  | { kind: 'source'; source: Pick<TaskSourceState, 'sourceKey' | 'columns'> }

/** The id of a board view, to key what a person keeps for one view. */
export function boardViewId(view: BoardView): string {
  return view.kind === 'all' ? 'all' : view.source.sourceKey
}

/** The column for the board items of a source that have no column yet. It is
 *  not a provider column, so nothing can be moved into it. */
export const NO_COLUMN_ID = ''

export interface BoardColumn<T> {
  /** A `TaskColumn.id` in a source view, a status category in the mixed view. */
  id: string
  label: string
  category: TaskStatusCategory
  tasks: T[]
}

type BoardTask = Pick<Task, 'category' | 'placements'>

/** The column that holds a task in a view, or null when the view does not
 *  show the task (a source that does not list it). */
export function boardColumnIdOf(task: BoardTask, view: BoardView): string | null {
  if (view.kind === 'all') return task.category
  const placement = task.placements.find((held) => held.sourceKey === view.source.sourceKey)
  if (!placement) return null
  const known = view.source.columns.some((column) => column.id === placement.columnId)
  return known && placement.columnId !== null ? placement.columnId : NO_COLUMN_ID
}

/**
 * Bucket tasks into the columns of a view. `tasks` arrives already searched,
 * filtered and ordered by the page, so the board is the *same* set as the list
 * re-plotted — a card can never appear in one layout and not the other.
 *
 * A source view shows the provider's columns with the provider's names in the
 * provider's order. The mixed view has one column for each status category,
 * because columns of two sources do not line up, and a task that two sources
 * list shows one time. A task whose column the source did not report goes to
 * a leading "No column", so it never vanishes from the board.
 */
export function buildBoard<T extends BoardTask>(tasks: readonly T[], view: BoardView): BoardColumn<T>[] {
  const columns: BoardColumn<T>[] = view.kind === 'all'
    ? TASK_CATEGORIES.map((category) => ({ id: category, label: CATEGORY_META[category].label, category, tasks: [] }))
    : view.source.columns.map((column: TaskColumn) => ({ id: column.id, label: column.name, category: column.category, tasks: [] }))
  const byId = new Map(columns.map((column) => [column.id, column]))
  const unplaced: T[] = []
  for (const task of tasks) {
    const columnId = boardColumnIdOf(task, view)
    if (columnId === null) continue
    const column = byId.get(columnId)
    if (column) column.tasks.push(task)
    else unplaced.push(task)
  }
  if (unplaced.length === 0) return columns
  return [{ id: NO_COLUMN_ID, label: 'No column', category: 'open', tasks: unplaced }, ...columns]
}

/** What `tasksMove` takes to put a task in a column of a view. Null for the
 *  "No column" column, which no provider has. */
export function moveTargetFor(view: BoardView, columnId: string): TaskMoveTarget | null {
  if (columnId === NO_COLUMN_ID) return null
  if (view.kind === 'source') return { sourceKey: view.source.sourceKey, columnId }
  const category = TASK_CATEGORIES.find((candidate) => candidate === columnId)
  return category ? { category } : null
}

/** Where a task is in one source that lists it, in words a person reads. */
export interface TaskPlacementLabel {
  sourceKey: string
  /** The source as the host names it, or its key until a host describes it. */
  sourceLabel: string
  /** Null for a board item that has no column yet. */
  columnName: string | null
  columns: TaskColumn[]
  columnId: string | null
}

/** A task's column in each source that lists it. */
export function taskPlacementLabels(
  task: Pick<Task, 'placements'>,
  sourceByKey: ReadonlyMap<string, Pick<TaskSourceState, 'label' | 'columns'>>,
): TaskPlacementLabel[] {
  return task.placements.map((placement) => {
    const source = sourceByKey.get(placement.sourceKey)
    const columns = source?.columns ?? []
    return {
      sourceKey: placement.sourceKey,
      sourceLabel: source?.label ?? placement.sourceKey,
      columnName: columns.find((column) => column.id === placement.columnId)?.name ?? null,
      columns,
      columnId: placement.columnId,
    }
  })
}
