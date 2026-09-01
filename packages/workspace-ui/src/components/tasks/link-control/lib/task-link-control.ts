import type { TaskLinkedTask, TaskStatus } from '@solus/contracts/task-types'

/**
 * What the Link control on a conversation card says, from the edges the store
 * knows. Pure, so the three states are testable without a card.
 */

/** Where a card's conversation lives, handed down by the transcript so every
 *  card in it files links on the same host, scopes the picker to the same
 *  project, and offers the same one-click task. */
export interface TaskLinkContext {
  serverId?: string
  projectKey?: string | null
  conversationTaskId?: string | null
}

/** `T-412`, or the id's head where a task has no short id yet (a task minted
 *  on another host and not yet numbered here). */
export function linkedTaskRef(task: Pick<TaskLinkedTask, 'taskId' | 'shortId'>): string {
  return task.shortId ? `T-${task.shortId}` : task.taskId.slice(0, 6)
}

export type TaskLinkControlState =
  /** The host has not answered yet: draw nothing rather than a wrong verb. */
  | { kind: 'unknown' }
  /** Nothing links this. `currentTask` is the conversation's own task, when
   *  it has one — the one-click target. */
  | { kind: 'none'; currentTask: TaskLinkedTaskSummary | null }
  /** Exactly one task links this: name it, and offer the way out. */
  | { kind: 'one'; task: TaskLinkedTask; label: string }
  /** Several do: count them, and offer the picker to manage the set. */
  | { kind: 'many'; tasks: TaskLinkedTask[]; label: string }

export interface TaskLinkedTaskSummary {
  taskId: string
  title: string
  status: TaskStatus
  shortId?: number
}

export function taskLinkControlState(
  linked: TaskLinkedTask[] | undefined,
  currentTask: TaskLinkedTaskSummary | null,
): TaskLinkControlState {
  if (!linked) return { kind: 'unknown' }
  if (linked.length === 0) return { kind: 'none', currentTask }
  if (linked.length === 1) {
    const [task] = linked
    return { kind: 'one', task, label: `Linked to ${linkedTaskRef(task)} · ${task.title}` }
  }
  return { kind: 'many', tasks: linked, label: `Linked to ${linked.length} tasks` }
}

/** The one-click verb when nothing is linked yet: the conversation's own task
 *  by reference, else the picker. */
export function linkVerb(state: Extract<TaskLinkControlState, { kind: 'none' }>): string {
  return state.currentTask ? `Link to ${linkedTaskRef(state.currentTask)}` : 'Link to task…'
}

/**
 * The picker's rows: the conversation's own task first, then live tasks, then
 * any task that links the target but is finished — it has to stay listed, or
 * there is no way to unlink it. Each row says whether it is checked.
 */
export interface TaskLinkPickerRow {
  taskId: string
  title: string
  status: TaskStatus
  shortId?: number
  linked: boolean
  /** The conversation's own task, listed first and labelled. */
  current: boolean
}

export function taskLinkPickerRows(
  candidates: TaskLinkedTaskSummary[],
  linked: TaskLinkedTask[],
  currentTaskId: string | null,
): TaskLinkPickerRow[] {
  const linkedIds = new Set(linked.map((edge) => edge.taskId))
  const seen = new Set<string>()
  const rows: TaskLinkPickerRow[] = []
  const push = (task: TaskLinkedTaskSummary) => {
    if (seen.has(task.taskId)) return
    seen.add(task.taskId)
    rows.push({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      shortId: task.shortId,
      linked: linkedIds.has(task.taskId),
      current: task.taskId === currentTaskId,
    })
  }
  const current = candidates.find((task) => task.taskId === currentTaskId)
  if (current) push(current)
  for (const task of candidates) push(task)
  for (const edge of linked) push(edge)
  return rows
}
