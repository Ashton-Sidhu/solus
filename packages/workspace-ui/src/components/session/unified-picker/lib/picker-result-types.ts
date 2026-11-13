/**
 * The types of result the search lists (docs/plans/unified-search.md, "Search
 * types"). `all` lists every type; each other type lists one kind of record.
 * The search opens on `all` each time: a type is a choice for one visit.
 */
export type PickerResultType = 'all' | 'sessions' | 'tasks' | 'works' | 'pullRequests' | 'automations' | 'projects'

/** A type whose rows are records: neither tasks nor sessions. */
export type PickerRecordResultType = Exclude<PickerResultType, 'all' | 'sessions' | 'tasks'>

/** Every type, in the order of the tabs. */
export const PICKER_RESULT_TYPES: readonly PickerResultType[] = ['all', 'sessions', 'tasks', 'works', 'pullRequests', 'automations', 'projects']

/** The types a guest of a share link has: the shared session is all they read (host-sharing.md §10). */
export const GUEST_PICKER_RESULT_TYPES: readonly PickerResultType[] = ['all', 'sessions']

export const PICKER_RESULT_LABELS = {
  all: 'All',
  sessions: 'Sessions',
  tasks: 'Tasks',
  works: 'Works',
  pullRequests: 'Pull requests',
  automations: 'Automations',
  projects: 'Projects',
} satisfies Record<PickerResultType, string>

/** What the search box asks for under each type. */
export const PICKER_RESULT_PLACEHOLDERS = {
  all: 'Search',
  sessions: 'Search sessions',
  tasks: 'Search tasks',
  works: 'Search works',
  pullRequests: 'Search pull requests',
  automations: 'Search automations',
  projects: 'Search projects',
} satisfies Record<PickerResultType, string>

export function isRecordResultType(type: PickerResultType | undefined): type is PickerRecordResultType {
  return type === 'works' || type === 'pullRequests' || type === 'automations' || type === 'projects'
}

/** Whether a list of this type holds sessions, so the hosts are asked for them. */
export function listsSessions(type: PickerResultType): boolean {
  return type === 'all' || type === 'sessions'
}

/** Whether a list of this type holds tasks. */
export function listsTasks(type: PickerResultType): boolean {
  return type === 'all' || type === 'tasks'
}

/** Whether a list of this type holds the records of `recordType`. */
export function listsRecords(type: PickerResultType, recordType: PickerRecordResultType): boolean {
  return type === 'all' || type === recordType
}

/** The type one tab to the left or right. The ends join, so one key reaches
 *  the last tab from the first. */
export function adjacentResultType(types: readonly PickerResultType[], current: PickerResultType, step: 1 | -1): PickerResultType {
  const index = types.indexOf(current)
  return types[(Math.max(index, 0) + step + types.length) % types.length] ?? 'all'
}

/** Which way a key moves the type: → is the next tab, ← the one before, and
 *  0 is no move. A modifier leaves the arrows to the search box, so the caret
 *  still moves by word and the text still selects. */
export function typeStepOf(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey'>): 1 | -1 | 0 {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return 0
  return event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
}
