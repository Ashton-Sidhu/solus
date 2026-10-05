import type { DraftRow } from './draft-list'
import type { SidebarTask } from './task-list'

/** Where a row sits in the one list. */
export type SidebarSection = 'tasks' | 'sessions' | 'working' | 'snoozed' | 'completed'

/**
 * One entry of the sidebar's single list. Drafts, the Tasks section, the
 * Sessions section, the Working section, and the Snoozed and Completed
 * sections are one list with section headers as entries
 * (docs/plans/sidebar-motion.md, step 3), so a row that changes section, and a
 * draft that arrives or leaves, animate like any other change of order.
 */
export type SidebarListItem =
  | { kind: 'draft'; key: string; draft: DraftRow }
  | { kind: 'drafts-divider'; key: string }
  | { kind: 'header'; key: string; section: SidebarSection; count: number; isOpen: boolean }
  | { kind: 'task'; key: string; section: SidebarSection; task: SidebarTask }

export interface SidebarListInput {
  drafts: readonly DraftRow[]
  /** Open tasks: each row opens its lead's conversation with the task page
   *  beside it (docs/plans/task-conversation.md). */
  tasks: readonly SidebarTask[]
  /** Open sessions that are not a task's own: a session with no task, and a
   *  session linked to a task that has no row in `tasks`. */
  sessions: readonly SidebarTask[]
  /** Open tasks and sessions whose agent is busy without the user. */
  working: readonly SidebarTask[]
  snoozed: readonly SidebarTask[]
  completed: readonly SidebarTask[]
  isTasksOpen: boolean
  isSessionsOpen: boolean
  isWorkingOpen: boolean
  isSnoozedOpen: boolean
  isCompletedOpen: boolean
  /** The row a collapsed section still shows: the one holding the conversation
   *  on screen, so the row you are reading never disappears into a section. The
   *  store leaves out a row the user is completing (`shelfRevealTaskId`). */
  shelfRevealTaskId: string | null
}

/**
 * A row's list key names its variant as well as the row: a task or a session
 * row is a full card and a shelved row is slim. Changing variant mounts the
 * other shape, which the list cross-fades, while a row that keeps its shape —
 * a session gaining a lead, a slim row moving between the two shelves — keeps
 * its element and slides.
 */
function taskItem(task: SidebarTask, section: SidebarSection): SidebarListItem {
  // A working row keeps the card it had, so a row that starts or finishes a
  // turn slides between sections rather than changing shape.
  const variant = section === 'tasks' || section === 'sessions' || section === 'working' ? 'card' : 'slim'
  return { kind: 'task', key: `${task.id}:${variant}`, section, task }
}

function section(
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

export function buildSidebarListItems(input: SidebarListInput): SidebarListItem[] {
  const drafts: SidebarListItem[] = input.drafts.map((draft) => ({
    kind: 'draft',
    key: `draft:${draft.draftId}`,
    draft,
  }))
  return [
    ...drafts,
    ...(drafts.length > 0 ? [{ kind: 'drafts-divider', key: 'drafts-divider' } as const] : []),
    ...section('tasks', input.tasks, input.isTasksOpen, input.shelfRevealTaskId),
    // With no tasks, sessions are the whole list: a header would only divide
    // them from nothing, so they stand bare and cannot collapse.
    ...(input.tasks.length > 0
      ? section('sessions', input.sessions, input.isSessionsOpen, input.shelfRevealTaskId)
      : input.sessions.map((task) => taskItem(task, 'sessions'))),
    ...section('working', input.working, input.isWorkingOpen, input.shelfRevealTaskId),
    ...section('snoozed', input.snoozed, input.isSnoozedOpen, input.shelfRevealTaskId),
    ...section('completed', input.completed, input.isCompletedOpen, input.shelfRevealTaskId),
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
