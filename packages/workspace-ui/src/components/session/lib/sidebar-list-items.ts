import type { PinnedSession } from '@solus/contracts/types'
import type { DraftRow } from './draft-list'
import type { SidebarTask } from './task-list'
import type { SidebarFolder } from './sidebar-project-folders'

/** Where a row sits in the one list. */
export type SidebarSection = 'sessions' | 'shared' | 'pinned' | 'working' | 'snoozed' | 'completed'

/**
 * One entry of the sidebar's single list. Drafts, the sessions, Shared with
 * you, the Pinned and Working sections, and the Snoozed and Completed sections are one list with section headers as entries
 * (docs/plans/sidebar-motion.md, step 3), so a row that changes section, and a
 * draft that arrives or leaves, animate like any other change of order.
 */
export type SidebarListItem =
  /** `folderKey` names the project folder a draft sits in, in the project view. */
  | { kind: 'draft'; key: string; draft: DraftRow; folderKey?: string }
  | { kind: 'drafts-divider'; key: string }
  /** `canToggle` is false when the section holds only the row on screen: a
   *  closed section still shows that row, so a toggle would hide nothing. */
  | { kind: 'header'; key: string; section: SidebarSection; count: number; isOpen: boolean; canToggle: boolean }
  /** A project folder's header, in the project view only. */
  | { kind: 'folder'; key: string; folder: SidebarFolder }
  /** `folderKey` names the project folder a row sits in, in the project view. */
  | { kind: 'task'; key: string; section: SidebarSection; task: SidebarTask; folderKey?: string }
  /** A pinned session the list has no row for, such as a closed one. */
  | { kind: 'pinned'; key: string; pin: PinnedSession }

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
  isPinnedOpen: boolean
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
 * row moving between the two shelves — keeps its element and slides.
 */
export function taskItem(task: SidebarTask, section: SidebarSection): Extract<SidebarListItem, { kind: 'task' }> {
  // A working row keeps the card it had, so a row that starts or finishes a
  // turn slides between sections rather than changing shape.
  // A pinned row keeps the shape its state gives it, as the row draws itself.
  const isCard = section === 'pinned'
    ? task.lifecycle === 'active' || !!task.share
    : section === 'sessions' || section === 'shared' || section === 'working'
  const variant = isCard ? 'card' : 'slim'
  return { kind: 'task', key: `${task.id}:${variant}`, section, task }
}

export function sectionItems(
  name: SidebarSection,
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

/** The Pinned section, in pin order. A pin with a row draws that row, so it
 *  shows its state as it would in any other section; a closed section still
 *  shows the row on screen. */
export function pinnedItems(
  entries: readonly PinnedEntry[],
  isOpen: boolean,
  shelfRevealTaskId: string | null,
): SidebarListItem[] {
  if (entries.length === 0) return []
  const isOnScreen = (entry: PinnedEntry) => entry.row !== null && entry.row.id === shelfRevealTaskId
  return [
    {
      kind: 'header',
      key: 'header:pinned',
      section: 'pinned',
      count: entries.length,
      isOpen,
      canToggle: entries.some((entry) => !isOnScreen(entry)),
    },
    ...(isOpen ? entries : entries.filter(isOnScreen)).map((entry): SidebarListItem =>
      entry.row
        ? taskItem(entry.row, 'pinned')
        : { kind: 'pinned', key: `pinned:${entry.pin.serverId ?? ''}:${entry.pin.sessionId}`, pin: entry.pin },
    ),
  ]
}

/** A pinned session matches a search by its row's title and project, or by
 *  the pin's title when it has no row. */
export function filterPinnedEntries(entries: readonly PinnedEntry[], query: string): readonly PinnedEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return entries
  return entries.filter((entry) =>
    (entry.row ? `${entry.row.title} ${entry.row.projectLabel}` : entry.pin.title).toLocaleLowerCase().includes(needle),
  )
}

export function draftItem(draft: DraftRow): Extract<SidebarListItem, { kind: 'draft' }> {
  return { kind: 'draft', key: `draft:${draft.draftId}`, draft }
}

/** Drafts lead the status view, with a divider below them when there are any. */
export function draftItems(drafts: readonly DraftRow[]): SidebarListItem[] {
  if (drafts.length === 0) return []
  return [...drafts.map(draftItem), { kind: 'drafts-divider', key: 'drafts-divider' }]
}

export function buildSidebarListItems(input: SidebarListInput): SidebarListItem[] {
  return [
    ...draftItems(input.drafts),
    // Sessions are the body of the list: a header would only divide them from
    // nothing, so they stand bare and cannot collapse.
    ...input.sessions.map((task) => taskItem(task, 'sessions')),
    ...sectionItems('shared', input.shared, input.isSharedOpen, input.shelfRevealTaskId),
    ...pinnedItems(input.pinned, input.isPinnedOpen, input.shelfRevealTaskId),
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
