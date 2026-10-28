import type { DraftRow } from './draft-list'
import type { SidebarTask } from './task-list'
import type { SidebarFolder } from './sidebar-project-folders'

/** Where a row sits in the one list. */
export type SidebarSection = 'sessions' | 'shared' | 'working' | 'snoozed' | 'completed'

/**
 * One entry of the sidebar's single list. Drafts, the sessions, Shared with
 * you, the Working section, and the Snoozed and Completed sections are one list with section headers as entries
 * (docs/plans/sidebar-motion.md, step 3), so a row that changes section, and a
 * draft that arrives or leaves, animate like any other change of order.
 */
export type SidebarListItem =
  /** `folderKey` names the project folder a draft sits in, in the project view. */
  | { kind: 'draft'; key: string; draft: DraftRow; folderKey?: string }
  | { kind: 'drafts-divider'; key: string }
  | { kind: 'header'; key: string; section: SidebarSection; count: number; isOpen: boolean }
  /** A project folder's header, in the project view only. */
  | { kind: 'folder'; key: string; folder: SidebarFolder }
  /** `folderKey` names the project folder a row sits in, in the project view. */
  | { kind: 'task'; key: string; section: SidebarSection; task: SidebarTask; folderKey?: string }

export interface SidebarListInput {
  drafts: readonly DraftRow[]
  /** Open sessions that are not working. Every row stands for one session; a
   *  session linked to a task names it in its tooltip. */
  sessions: readonly SidebarTask[]
  /** Other people's sessions in the reader's list (docs/plans/shared-with-you.md). */
  shared: readonly SidebarTask[]
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
 * row moving between the two shelves — keeps its element and slides.
 */
export function taskItem(task: SidebarTask, section: SidebarSection): Extract<SidebarListItem, { kind: 'task' }> {
  // A working row keeps the card it had, so a row that starts or finishes a
  // turn slides between sections rather than changing shape.
  const variant = section === 'sessions' || section === 'shared' || section === 'working' ? 'card' : 'slim'
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
    { kind: 'header', key: `header:${name}`, section: name, count: tasks.length, isOpen },
    ...shown.map((task) => taskItem(task, name)),
  ]
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
