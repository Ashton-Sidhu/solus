import type { Activity, TaskEventTarget } from '@solus/contracts/activity'
import type { TaskEventKind } from '@solus/contracts/task-types'
import type { Attribution } from '@solus/contracts/user'
import { newActivity } from '../activity/activity'

/** Cap on the activity returned with a task's attachments. The feed is a page,
 * not an archive; deep history would get its own paged read if anything asked. */
export const TASK_ACTIVITY_LIMIT = 200

/**
 * One `task_changed` activity (plans/012 §5): what Solus did to a task's
 * attachments (`linked`, `unlinked`, `session_started`). A change of the task
 * itself has no activity here: the provider keeps that history. Append it
 * inside the transaction of the change it records.
 */
export function taskChanged(
  taskId: string,
  by: Attribution,
  change: TaskEventKind,
  fields: { from?: string | null; to?: string | null; target?: TaskEventTarget } = {},
  now = Date.now(),
): Activity {
  return newActivity({ kind: 'task', id: taskId }, by, { kind: 'task_changed', change, ...fields }, now)
}
