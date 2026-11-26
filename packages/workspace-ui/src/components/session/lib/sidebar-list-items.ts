import type { PinnedSession } from '@solus/contracts/types'
import type { DraftRow } from './draft-list'
import type { SidebarTask } from './task-list'
import type { SidebarFolder } from './sidebar-project-folders'

/** Where a row sits in the one list. */
export type SidebarSection = 'sessions' | 'shared' | 'pinned' | 'working' | 'snoozed' | 'completed'
export type SidebarShelf = Exclude<SidebarSection, 'sessions' | 'pinned'>

/**
 * One entry of the sidebar's single list. Drafts, pinned and active sessions,
 * Shared with you, Working, Snoozed, and Completed form one ordered list.
 * Only the collapsible sections have headers. The renderer uses those headers
 * to give each shelf a separate scroll area.
 */
export type SidebarListItem =
  /** `folderKey` names the project folder a draft sits in, in the project view. */
  | { kind: 'draft'; key: string; draft: DraftRow; folderKey?: string }
  | { kind: 'drafts-divider'; key: string }
  /** `canToggle` is false when the section holds only the row on screen: a
   *  closed section still shows that row, so a toggle would hide nothing. */
  | { kind: 'header'; key: string; section: SidebarShelf; count: number; isOpen: boolean; canToggle: boolean }
  /** A project folder's header, in the project view only. */
  | { kind: 'folder'; key: string; folder: SidebarFolder }
  /** `folderKey` names the project folder a row sits in, in the project view. */
  | { kind: 'task'; key: string; section: SidebarSection; task: SidebarTask; folderKey?: string }
  /** A pinned session the list has no row for, such as a closed one. */
  | { kind: 'pinned'; key: string; pin: PinnedSession }

type SidebarListHeader = Extract<SidebarListItem, { kind: 'header' }>
export type SidebarListRow = Exclude<SidebarListItem, SidebarListHeader>

/** Section headers start the shelves below the main list in both views. */
export function groupSidebarListItems(items: readonly SidebarListItem[]) {
  const mainRows: SidebarListRow[] = []
  const shelves: { header: SidebarListHeader; rows: SidebarListRow[] }[] = []
  let rows = mainRows
  for (const item of items) {
    if (item.kind === 'header') {
      rows = []
      shelves.push({ header: item, rows })
    } else {
      rows.push(item)
    }
  }
  return { mainRows, shelves }
}

/** One entry of the Pinned section: a pin, with the row that stands for its
 *  session when the list has one. */
export interface PinnedEntry {
  pin: PinnedSession
  row: SidebarTask | null
}

export interface SidebarListInput {
  drafts: readonly DraftRow[]
  /** Open sessions that are not working. Every row stands for one session; a
   *  session linked to a task names it in its tooltip. */
  sessions: readonly SidebarTask[]
  /** Other people's sessions in the reader's list (docs/plans/shared-with-you.md). */
  shared: readonly SidebarTask[]
  /** The sessions the person pinned, open or not. No other section lists them. */
  pinned: readonly PinnedEntry[]
  /** Open sessions whose agent is busy without the user. */
  working: readonly SidebarTask[]
  snoozed: readonly SidebarTask[]
  completed: readonly SidebarTask[]
  isSharedOpen: boolean
  isWorkingOpen: boolean
  isSnoozedOpen: boolean
  isCompletedOpen: boolean
  /** The row a collapsed section still shows: the one holding the conversation
   *  on screen, so the row you are reading never disappears into a section. The
   *  store leaves out a row the user is completing (`shelfRevealTaskId`). */
  shelfRevealTaskId: string | null
}

/**
 * A row's list key names its variant as well as the row: an open session row
 * is a full card and a shelved row is slim. Changing variant mounts the other
 * shape, which the list cross-fades, while a row that keeps its shape — a slim
 * row moving within a shelf — keeps its element and slides.
 */
export function taskItem(task: SidebarTask, section: SidebarSection): Extract<SidebarListItem, { kind: 'task' }> {
  // A working row keeps its card shape when a turn starts or finishes.
  const isCard = section === 'sessions' || section === 'shared' || section === 'working'
  const variant = isCard ? 'card' : 'slim'
  return { kind: 'task', key: `${task.key}:${variant}`, section, task }
}

export function sectionItems(
  name: SidebarShelf,
  tasks: readonly SidebarTask[],
  isOpen: boolean,
  shelfRevealTaskId: string | null,
): SidebarListItem[] {
  if (tasks.length === 0) return []
  const shown = isOpen ? tasks : tasks.filter((task) => task.id === shelfRevealTaskId)
  return [
    {
      kind: 'header',
      key: `header:${name}`,
      section: name,
      count: tasks.length,
      isOpen,
      canToggle: tasks.some((task) => task.id !== shelfRevealTaskId),
    },
    ...shown.map((task) => taskItem(task, name)),
  ]
}

/** Pins lead the session list without a separate header or collapse state. */
export function pinnedItems(entries: readonly PinnedEntry[]): SidebarListItem[] {
  return entries.map((entry): SidebarListItem =>
    entry.row
      ? taskItem(entry.row, 'pinned')
      : { kind: 'pinned', key: `pinned:${entry.pin.serverId ?? ''}:${entry.pin.sessionId}`, pin: entry.pin },
  )
}

/** A pinned session matches a search by its row's title and project, or by
 *  the pin's title when it has no row. */
export function filterPinnedEntries(entries: readonly PinnedEntry[], query: string): readonly PinnedEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return entries
  return entries.filter((entry) =>
    (entry.row ? `${entry.row.title} ${entry.row.automationName ?? ''} ${entry.row.projectLabel}` : entry.pin.title).toLocaleLowerCase().includes(needle),
  )
}

export function draftItem(draft: DraftRow): Extract<SidebarListItem, { kind: 'draft' }> {
  return { kind: 'draft', key: `draft:${draft.draftId}`, draft }
}

/** Drafts follow the pins in the status view, with a divider below them when
 *  there are any. */
export function draftItems(drafts: readonly DraftRow[]): SidebarListItem[] {
  if (drafts.length === 0) return []
  return [...drafts.map(draftItem), { kind: 'drafts-divider', key: 'drafts-divider' }]
}

export function buildSidebarListItems(input: SidebarListInput): SidebarListItem[] {
  return [
    ...pinnedItems(input.pinned),
    ...draftItems(input.drafts),
    // Active sessions stay visible below the drafts and cannot collapse.
    ...input.sessions.map((task) => taskItem(task, 'sessions')),
    ...sectionItems('shared', input.shared, input.isSharedOpen, input.shelfRevealTaskId),
    ...sectionItems('working', input.working, input.isWorkingOpen, input.shelfRevealTaskId),
    ...sectionItems('snoozed', input.snoozed, input.isSnoozedOpen, input.shelfRevealTaskId),
    ...sectionItems('completed', input.completed, input.isCompletedOpen, input.shelfRevealTaskId),
  ]
}

/**
 * What the list's motion pass keys on: every entry in order, with each task's
 * section. A re-render that changes only a row's contents leaves this string
 * equal, so it reads no layout and animates nothing. Takes any entry with a key
 * so a client can add entries of its own (the phone adds pinned sessions).
 */
export function sidebarListOrderKey(
  items: readonly ({ kind: string; key: string } | SidebarListItem)[],
): string {
  return items
    .map((item) => ('section' in item && item.kind === 'task' ? `${item.key}:${item.section}` : item.key))
    .join('\0')
}
