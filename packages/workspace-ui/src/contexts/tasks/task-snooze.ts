import type { Task } from '@solus/contracts/task-types'

export interface TaskSnoozeReminder {
  detail: string
  wokeAt: number
}

/** The conversation notice for a snooze that has reached its wake time. */
export function resolveTaskSnoozeReminder(
  task: Pick<Task, 'snoozedUntil' | 'snoozeNote'> | null | undefined,
  now: number,
): TaskSnoozeReminder | null {
  const wokeAt = task?.snoozedUntil ?? 0
  if (!wokeAt || wokeAt > now) return null
  return {
    detail: task?.snoozeNote?.trim() || 'Ready to continue',
    wokeAt,
  }
}
