import type { Task } from '@solus/contracts/task-types'
import type { SidebarSessionChild } from '../../../../contexts/workspace/session-sidebar.store.svelte'
import { taskPickerSections } from '../../../tasks/lib/task-picker-sections'

/**
 * A rendered row. Tasks and their expanded sessions share one `entryIndex`
 * sequence, so the arrow keys walk past headers and ⏎ always means "the thing
 * under the cursor" whether that is a task or one of its sessions.
 */
export type PickerRow =
  | { kind: 'header'; key: string; label: string; count: number; accent?: boolean }
  | {
      kind: 'task'
      key: string
      entryIndex: number
      task: Task
      sessions: SidebarSessionChild[]
      expanded: boolean
    }
  | {
      kind: 'session'
      key: string
      entryIndex: number
      task: Task
      session: SidebarSessionChild
      /** Ends the spine at this row rather than running it into the next task. */
      isLast: boolean
    }

/** A row the keyboard can land on: everything except a section header. */
export type PickerEntry = Exclude<PickerRow, { kind: 'header' }>

/** The last path segment of the task's project, or "Inbox" when it has none. */
export function projectLabel(task: Task): string {
  if (!task.projectKey) return 'Inbox'
  return task.projectKey.replace(/\/$/, '').split('/').at(-1) || task.projectKey
}

/** The fields the old task picker matched, kept so no result disappears. */
export function taskMatches(task: Task, needle: string): boolean {
  if (!needle) return true
  return [task.title, task.body, task.shortId, task.id, task.projectKey, task.status]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
    .includes(needle)
}

export function sessionMatches(session: SidebarSessionChild, needle: string): boolean {
  return !needle || session.label.toLocaleLowerCase().includes(needle)
}

export interface PickerRowsInput {
  tasks: Task[]
  query: string
  sessionsFor: (task: Task) => SidebarSessionChild[]
  expandedTaskIds: ReadonlySet<string>
  /** Durable tasks currently visible in the session sidebar. */
  openTaskIds?: ReadonlySet<string>
  /** Durable tasks currently on the session sidebar's snoozed shelf. */
  snoozedTaskIds?: ReadonlySet<string>
  /** The task group under the cursor. It opens only while the cursor remains
   *  on that task or one of its sessions. */
  selectedTaskId?: string | null
}

/**
 * Build the list.
 *
 * With no query a task shows its sessions only when the reader opened it. With
 * a query a task is kept when it matches *or* one of its sessions does. A task
 * match shows every session; a session-only match shows only matching sessions.
 */
export interface PickerList {
  rows: PickerRow[]
  /** The rows the keyboard can land on, in order. */
  entries: PickerEntry[]
  /** Tasks kept, for the footer's "n of m". */
  taskCount: number
  /** Sessions the kept tasks own, expanded or not. */
  sessionCount: number
}

/**
 * Row heights, in CSS pixels, for the virtualiser.
 *
 * The list is virtualised, so a row's height has to be known before it is
 * painted; these are the same numbers the row markup sets, and a change to one
 * has to move with the other. The touch column is the phone's 44px-target
 * geometry; the pointer column is the desktop overlay's. The last session under
 * a task carries the nest's bottom padding so the spine can stop short of the
 * next task.
 */
export function pickerRowHeight(row: PickerRow, touch: boolean): number {
  if (row.kind === 'header') return touch ? 34 : 32
  if (row.kind === 'task') return touch ? 58 : 44
  if (touch) return 50
  return row.isLast ? 36 : 32
}

export function buildPickerRows(input: PickerRowsInput): PickerList {
  const needle = input.query.trim().toLocaleLowerCase()
  const kept: { task: Task; sessions: SidebarSessionChild[] }[] = []
  for (const task of input.tasks) {
    const sessions = input.sessionsFor(task)
    const taskHit = taskMatches(task, needle)
    const matchingSessions = needle
      ? sessions.filter((session) => sessionMatches(session, needle))
      : []
    if (!taskHit && matchingSessions.length === 0) continue
    kept.push({ task, sessions: taskHit ? sessions : matchingSessions })
  }

  const byTaskId = new Map(kept.map((item) => [item.task.id, item]))
  const rows: PickerRow[] = []
  const entries: PickerEntry[] = []
  const push = (row: PickerEntry) => {
    rows.push(row)
    entries.push(row)
  }

  const openTaskIds = input.openTaskIds ?? new Set<string>()
  const snoozedTaskIds = input.snoozedTaskIds ?? new Set<string>()
  const openTasks = kept
    .map((item) => item.task)
    .filter((task) => task.status === 'in_progress' && openTaskIds.has(task.id))
  const snoozedTasks = kept
    .map((item) => item.task)
    .filter((task) => snoozedTaskIds.has(task.id))
  const liftedTaskIds = new Set([...openTasks, ...snoozedTasks].map((task) => task.id))
  const sections = [
    ...(openTasks.length
      ? [{ key: 'sidebar-open', label: 'Open', startIndex: 0, tasks: openTasks }]
      : []),
    ...(snoozedTasks.length
      ? [{ key: 'sidebar-snoozed', label: 'Snoozed', startIndex: openTasks.length, tasks: snoozedTasks, accent: true }]
      : []),
    ...taskPickerSections(
      kept.map((item) => item.task).filter((task) => !liftedTaskIds.has(task.id)),
    ),
  ]

  for (const section of sections) {
    rows.push({
      kind: 'header',
      key: `header:${section.key}`,
      label: section.label,
      count: section.tasks.length,
      accent: 'accent' in section && section.accent,
    })
    for (const task of section.tasks) {
      const item = byTaskId.get(task.id)!
      const expanded = !!needle
        || input.expandedTaskIds.has(task.id)
        || input.selectedTaskId === task.id
      push({
        kind: 'task',
        key: `task:${task.id}`,
        entryIndex: entries.length,
        task,
        sessions: item.sessions,
        expanded,
      })
      if (!expanded) continue
      item.sessions.forEach((session, index) => {
        push({
          kind: 'session',
          key: `session:${task.id}:${session.sessionId ?? session.tabId ?? index}`,
          entryIndex: entries.length,
          task,
          session,
          isLast: index === item.sessions.length - 1,
        })
      })
    }
  }
  return {
    rows,
    entries,
    taskCount: kept.length,
    sessionCount: kept.reduce((sum, item) => sum + item.sessions.length, 0),
  }
}

/** The row the keyboard's cursor is on, or -1 when the list is empty. */
export function selectedRowIndex(rows: readonly PickerRow[], selectedIndex: number): number {
  return rows.findIndex((row) => row.kind !== 'header' && row.entryIndex === selectedIndex)
}

/**
 * Where `→` goes: a collapsed task opens, an open one steps into its first
 * session. Null when the key has nothing to do.
 */
export function expandTarget(
  entry: PickerEntry | undefined,
): { action: 'expand'; taskId: string } | { action: 'step' } | null {
  if (entry?.kind !== 'task' || entry.sessions.length === 0) return null
  return entry.expanded ? { action: 'step' } : { action: 'expand', taskId: entry.task.id }
}

/**
 * Where `←` goes: a session returns to its task, an open task closes. The
 * parent index is looked up in the built list, so it can never point at a row
 * the query has since removed.
 */
export function collapseTarget(
  entries: readonly PickerEntry[],
  selectedIndex: number,
): { action: 'select'; entryIndex: number } | { action: 'collapse'; taskId: string } | null {
  const entry = entries[selectedIndex]
  if (!entry) return null
  if (entry.kind === 'session') {
    const parentIndex = entries.findIndex(
      (candidate) => candidate.kind === 'task' && candidate.task.id === entry.task.id,
    )
    return parentIndex >= 0 ? { action: 'select', entryIndex: parentIndex } : null
  }
  return entry.expanded ? { action: 'collapse', taskId: entry.task.id } : null
}
