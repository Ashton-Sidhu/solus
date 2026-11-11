import type { TaskLinkedTask } from '@solus/contracts/task-types'
import { taskRef } from '../../lib/tasks-api'

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

/** `#412` or `PROJ-12`, as a task row names the task. A task with no
 *  reference is a draft item of a board. */
export function linkedTaskRef(task: Pick<TaskLinkedTask, 'reference'>): string {
  return taskRef({ reference: task.reference, kind: task.reference ? 'issue' : 'draft' })
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

export type TaskLinkedTaskSummary = Pick<TaskLinkedTask, 'taskId' | 'title' | 'category' | 'reference'>

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
export interface TaskLinkPickerRow extends TaskLinkedTaskSummary {
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
      category: task.category,
      reference: task.reference,
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
