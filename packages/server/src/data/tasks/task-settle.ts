import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { resourceLinks } from '../links/schema'
import { SessionShelf } from '../sessions/session-states'
import { tasks } from './schema'
import { taskSessions } from './task-sessions'
import { database, type TaskCategoryChange } from './task-store'

/**
 * A finished task ends the work of its sessions, so each working session is
 * settled unless another task that is not finished still holds it. A task that
 * is not finished any more makes the sessions it settled active again. The
 * rule runs wherever a category can change: a write, a detail read, a source
 * read. A session of any organization follows the task, because the task has
 * none.
 */
export async function settleTaskSessions(changes: readonly TaskCategoryChange[]): Promise<void> {
  for (const change of changes) {
    const wasFinished = change.from === 'done'
    const isFinished = change.to === 'done'
    if (wasFinished === isFinished) continue
    const working = ((await taskSessions(ANY_ORGANIZATION, change.taskId))[change.taskId] ?? [])
      .filter((link) => link.role !== 'referenced')
      .map((link) => link.sessionId)
    for (const sessionId of working) {
      if (!isFinished) await new SessionShelf(sessionId).reopenFromTask()
      else if (!(await heldByUnfinishedTask(sessionId, change.taskId))) await new SessionShelf(sessionId).settle('task')
    }
  }
}

/** Another task works on the session and is not finished. A task with no copy
 *  on this host is not known to be finished, so it holds the session. */
async function heldByUnfinishedTask(sessionId: string, finishedTaskId: string): Promise<boolean> {
  const row = z.object({ task_id: z.string() }).nullish().parse(await database().get(sql`
    SELECT resource_links.source_id AS task_id FROM ${resourceLinks}
    LEFT JOIN ${tasks} ON tasks.id = resource_links.source_id
    WHERE resource_links.source_kind = 'task' AND resource_links.target_kind = 'session' AND resource_links.target_key = ${sessionId}
      AND resource_links.relation = 'works-on' AND resource_links.status = 'active'
      AND resource_links.source_id <> ${finishedTaskId} AND (tasks.id IS NULL OR tasks.category <> 'done')
    LIMIT 1
  `))
  return !!row
}
