import type { TaskStatus } from '../../session/lib/task-list'

// Logic for the breadcrumb that replaced the session tab strip — one line that
// always says exactly where you are (project › task › session) instead of a
// strip of everything you happened to open. Pure so the mark vocabulary and the
// menu ordering can be tested without a workspace store.

export type BreadcrumbDraftMode = 'existing-task' | 'new-task' | 'no-task' | null

export interface BreadcrumbTaskGroups<T> {
  open: T[]
  completed: T[]
}

export interface BreadcrumbLeafLabels {
  task: string | null
  session: string
}

/** Keep the breadcrumb picker easy to scan without changing the urgency order
 * it receives from the sidebar store. Work that can still continue comes first;
 * completed work stays available in a separate section below it. */
export function breadcrumbTaskGroups<T extends { status: TaskStatus }>(tasks: readonly T[]): BreadcrumbTaskGroups<T> {
  const open: T[] = []
  const completed: T[] = []
  for (const task of tasks) {
    if (task.status === 'done') completed.push(task)
    else open.push(task)
  }
  return { open, completed }
}

/** Match what the picker shows. Keeping this explicit lets the command list
 * omit whole rows, including each row's separate close action. */
export function breadcrumbTaskMatches(label: string, query: string): boolean {
  return label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
}

/** A draft names the destination being created rather than borrowing the
 * placeholder session title for every level of the path. */
export function breadcrumbLeafLabels(
  taskLabel: string,
  sessionLabel: string,
  draftMode: BreadcrumbDraftMode,
): BreadcrumbLeafLabels {
  if (draftMode === 'no-task') return { task: null, session: 'New session' }
  if (draftMode === 'new-task') return { task: 'New task', session: 'New session' }
  if (draftMode === 'existing-task') return { task: taskLabel, session: 'New session' }
  return { task: taskLabel, session: sessionLabel }
}

/** The app's own status palette, not the chart/brand ramps that happen to sit
 *  near it. Menu notes use the same colours as session status icons elsewhere. */
export function statusColor(status: TaskStatus): string | null {
  switch (status) {
    // Stopped and waiting on a person — the same terracotta the permission
    // prompts use.
    case 'question':
      return 'var(--solus-status-permission)'
    case 'plan':
      return 'var(--solus-status-running)'
    case 'running':
      return 'var(--solus-status-running-icon)'
    // Rate limiting is a provider delay rather than a request from the user,
    // so it uses the sidebar's amber instead of the permission terracotta.
    case 'limit':
      return 'var(--chart-2)'
    case 'error':
      return 'var(--solus-status-error)'
    default:
      return null
  }
}

/** What a menu row says about its own state. The crumb's menus are read one row
 *  at a time, top-down, so they say it in words: a silhouette has to be learned
 *  before it means anything, and colour alone is not a state anyone can name.
 *  Colour still carries the urgency, but it is now the word's colour, not the
 *  word's replacement. */
export interface StatusNote {
  text: string
  color: string
}

const STATUS_TEXT = new Map<TaskStatus, string>([
  ['question', 'Needs you'],
  ['plan', 'Plan ready'],
  ['error', 'Failed'],
  ['limit', 'Rate limited'],
  ['running', 'Running'],
])

export function statusNote(status: TaskStatus): StatusNote | null {
  const text = STATUS_TEXT.get(status)
  const color = statusColor(status)
  if (!text || !color) return null
  return { text, color }
}

export interface ProjectNote {
  text: string
  tone: 'primary' | 'destructive'
}

/**
 * What a project row in the picker says about itself, in the same words the
 * task list uses. Anything waiting outranks anything failed: a project with
 * both wants the count of what you can act on, not the count of what already
 * stopped.
 */
export function projectNote(waiting: number, failed: number): ProjectNote | null {
  if (waiting > 0) return { text: `${waiting} need${waiting === 1 ? 's' : ''} you`, tone: 'primary' }
  if (failed > 0) return { text: `${failed} failed`, tone: 'destructive' }
  return null
}
