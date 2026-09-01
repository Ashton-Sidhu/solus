import type { Session } from '@solus/contracts/types'
import type { Task } from '@solus/contracts/task-types'
import { hasSessionStarted } from '../../lib/sessionUtils'

interface SettingsTaskLookup {
  taskForSession(sessionId: string | null | undefined): Pick<Task, 'status'> | null
}

type SettingsExitSession = Pick<
  Session,
  'id' | 'agentSessionId' | 'handoffId' | 'messages' | 'status'
>

/** Settings can return to chat only when the selected session is current work.
 * Otherwise the chat route has no useful destination and the composer wins. */
export function shouldReturnToActiveSession(
  session: SettingsExitSession | undefined,
  tasks: SettingsTaskLookup,
): boolean {
  if (!hasSessionStarted(session)) return false
  const task = tasks.taskForSession(session.handoffId ?? session.id)
    ?? tasks.taskForSession(session.agentSessionId)
  return !task || task.status === 'in_progress' || task.status === 'in_review'
}
