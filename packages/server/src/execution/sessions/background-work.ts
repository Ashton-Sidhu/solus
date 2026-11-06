import type { AgentBackend } from '../agents/agent-backend'
import type { BackendSession } from '@solus/contracts/types'

/**
 * Which background work holds a session in 'background' (docs/background-work.md).
 * A sub-agent holds. A shell or Monitor is as often
 * a dev server or its watchdog as a wait, and only the agent knows which: it
 * holds only while the agent marks it as awaited with `background_wait`.
 * Codex commands hold by default; waiting=false explicitly leaves them running.
 */
export function backgroundWorkHolds(session: BackendSession): boolean {
  for (const taskId of session.backgroundTaskIds ?? []) {
    if (!session.awaitableTaskIds?.has(taskId) || session.awaitedTaskIds?.has(taskId)) return true
  }
  return false
}

/** The provider query is still open for background work, held or not: a new
 *  prompt goes into it, and Stop on the session cancels it. */
export function hasOpenBackgroundQuery(session: BackendSession): boolean {
  return session.status === 'background' || !!session.backgroundTaskIds?.size
}

export interface AwaitedTasksResult {
  matched: string[]
  unmatched: string[]
}

/** Mark or unmark the tasks the agent waits on. An id that is not in flight
 *  comes back unmatched and changes nothing. */
export function markAwaitedTasks(session: BackendSession, taskIds: readonly string[], waiting: boolean, backend?: Pick<AgentBackend, 'setBackgroundCommandWaiting'>): AwaitedTasksResult {
  const result: AwaitedTasksResult = { matched: [], unmatched: [] }
  for (const taskId of new Set(taskIds)) {
    if (backend?.setBackgroundCommandWaiting && session.agentSessionId) {
      const commandId = backend.setBackgroundCommandWaiting(session.agentSessionId, taskId, waiting)
      if (!commandId) {
        result.unmatched.push(taskId)
        continue
      }
      // Commands are announced as background tasks only when the turn ends.
      // A command from an older turn already has state to update here.
      if (session.backgroundTaskIds?.has(commandId)) {
        (session.awaitableTaskIds ??= new Set()).add(commandId)
        if (waiting) (session.awaitedTaskIds ??= new Set()).add(commandId)
        else session.awaitedTaskIds?.delete(commandId)
      }
      result.matched.push(taskId)
      continue
    }
    if (!session.backgroundTaskIds?.has(taskId)) {
      result.unmatched.push(taskId)
      continue
    }
    if (waiting) (session.awaitedTaskIds ??= new Set()).add(taskId)
    else session.awaitedTaskIds?.delete(taskId)
    result.matched.push(taskId)
  }
  return result
}
