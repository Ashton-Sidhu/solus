import type { BackendSession } from '@solus/contracts/types'

/**
 * Which background work holds a session in 'background' (docs/background-work.md).
 * A sub-agent and every Codex task hold. A Claude shell or Monitor is as often
 * a dev server or its watchdog as a wait, and only the agent knows which: it
 * holds only while the agent marks it as awaited with `background_wait`.
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
export function markAwaitedTasks(session: BackendSession, taskIds: readonly string[], waiting: boolean): AwaitedTasksResult {
  const result: AwaitedTasksResult = { matched: [], unmatched: [] }
  for (const taskId of new Set(taskIds)) {
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
