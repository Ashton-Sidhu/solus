import type { Task } from '@solus/contracts/task-types'
import type { Session } from '@solus/contracts/types'

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

/**
 * The wake notice for the task a conversation belongs to.
 *
 * A task link records the durable Solus session id — a handoff's, once its
 * provider thread has been replaced — so the provider-native id only answers
 * for links written before that identity existed. Reading the native id alone
 * finds no task for an ordinary session, and therefore never shows the notice.
 */
export function sessionSnoozeReminder(
  session: Pick<Session, 'id' | 'handoffId' | 'agentSessionId'> | null | undefined,
  tasks: {
    taskForSession(
      sessionId: string | null | undefined,
    ): Pick<Task, 'snoozedUntil' | 'snoozeNote'> | null
  },
  now: number,
): TaskSnoozeReminder | null {
  if (!session) return null
  const task = tasks.taskForSession(session.handoffId ?? session.id)
    ?? tasks.taskForSession(session.agentSessionId)
  return resolveTaskSnoozeReminder(task, now)
}
