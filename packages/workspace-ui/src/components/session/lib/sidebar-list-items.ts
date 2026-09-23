import type { DraftRow } from './draft-list'
import type { SidebarTask } from './task-list'

/** Where a task row sits in the one list. */
export type SidebarSection = 'active' | 'snoozed' | 'completed'

/**
 * One entry of the sidebar's single list. Drafts, the active column, and the
 * Snoozed and Completed sections are one list with section headers as entries
 * (docs/plans/sidebar-motion.md, step 3), so a row that changes section, and a
 * draft that arrives or leaves, animate like any other change of order.
 */
export type SidebarListItem =
  | { kind: 'draft'; key: string; draft: DraftRow }
  | { kind: 'drafts-divider'; key: string }
  | { kind: 'header'; key: string; section: 'snoozed' | 'completed'; count: number; isOpen: boolean }
  | { kind: 'task'; key: string; section: SidebarSection; task: SidebarTask }

export interface SidebarListInput {
  drafts: readonly DraftRow[]
  active: readonly SidebarTask[]
  snoozed: readonly SidebarTask[]
  completed: readonly SidebarTask[]
  isSnoozedOpen: boolean
  isCompletedOpen: boolean
  /** The row a collapsed section still shows: the one holding the conversation
   *  on screen, so the row you are reading never disappears into a shelf. The
   *  store leaves out a row the user is completing (`shelfRevealTaskId`). */
  shelfRevealTaskId: string | null
}

/**
 * A task row's list key names its variant as well as the row: an active row is
 * a full card and a shelved row is slim. Changing variant mounts the other
 * shape, which the list cross-fades, while a slim row that moves between the
 * two shelves keeps its element and slides.
 */
function taskItem(task: SidebarTask, section: SidebarSection): SidebarListItem {
  const variant = section === 'active' ? 'card' : 'slim'
  return { kind: 'task', key: `${task.listKey}:${variant}`, section, task }
}

function shelf(
  section: 'snoozed' | 'completed',
  tasks: readonly SidebarTask[],
  isOpen: boolean,
  shelfRevealTaskId: string | null,
): SidebarListItem[] {
  if (tasks.length === 0) return []
  const shown = isOpen ? tasks : tasks.filter((task) => task.id === shelfRevealTaskId)
  return [
    { kind: 'header', key: `header:${section}`, section, count: tasks.length, isOpen },
    ...shown.map((task) => taskItem(task, section)),
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
    ...input.active.map((task) => taskItem(task, 'active')),
    ...shelf('snoozed', input.snoozed, input.isSnoozedOpen, input.shelfRevealTaskId),
    ...shelf('completed', input.completed, input.isCompletedOpen, input.shelfRevealTaskId),
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
