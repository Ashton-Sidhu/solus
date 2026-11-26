import type { Issue } from '@solus/contracts/task-types'
import { createLogger } from '../../logger'
import { cachedTask, moveTask } from './task'
import { linkTaskSession } from './task-attachments'
import { assertTaskKey, loadTask } from './task-store'

const log = createLogger('main', 'session-task')

interface PrepareSessionTaskInput {
  /** A session that already has a provider conversation has passed its first
   * dispatch: its task is bound already. */
  existingAgentSessionId?: string | null
  /** The task the session joins. */
  issueId: string
  sessionId?: string
}

/**
 * First-dispatch boundary: bind the task a session names. A session never
 * makes a task of its own (docs/plans/task-conversation.md, decision 8).
 * Returns null for a resumed provider session, in which case nothing is read
 * or written.
 *
 * The link needs no copy of the task. A host that has none tries one provider
 * read and continues without a copy when it fails. A session that starts work
 * on an `open` task moves the task to `active` on the provider; a failure of
 * that move is logged and does not stop the session.
 *
 * `organizationId` is the caller's, for the link of a session that has no
 * record yet.
 */
export async function prepareSessionTask(organizationId: string, input: PrepareSessionTaskInput): Promise<Issue | null> {
  if (input.existingAgentSessionId) return null
  assertTaskKey(input.issueId)
  let task = await cachedTask(input.issueId).catch((error) => {
    log.warn('session_task_unreadable', { taskId: input.issueId, error: error instanceof Error ? error.message : String(error) })
    return null
  })
  // A provider session id is not available during the usual pre-launch bind;
  // the later `linkTaskSession` write makes the link then.
  if (input.sessionId) await linkTaskSession(organizationId, input.issueId, input.sessionId, 'working')
  if (task?.category === 'open') {
    task = await moveTask(input.issueId, { category: 'active' }).catch(async (error) => {
      log.warn('session_task_start_move_failed', { taskId: input.issueId, error: error instanceof Error ? error.message : String(error) })
      return loadTask(input.issueId)
    })
  }
  return task
}
