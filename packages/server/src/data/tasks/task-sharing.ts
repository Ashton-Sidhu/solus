import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { ShareResource } from '@solus/contracts/sharing'
import { getDatabase } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import type { ContainingTask } from '../../sharing/share-manager'
import { scopeClause } from '../scope'
import { taskLinks, taskSessionLinks, tasks } from './schema'

/**
 * What a task's share reaches (docs/plans/multiplayer-sharing.md §3.4): the sessions
 * attempted under it and the works linked to it. The share manager asks these two
 * questions and joins nothing of the tasks domain itself.
 */

const sessionIdRowSchema = z.object({ session_id: z.string() })
const workIdRowSchema = z.object({ target_key: z.string() })
const containingTaskRowSchema = z.object({ task_id: z.string(), title: z.string() })

/** Task ids per statement: far below the bound-parameter limit of either engine. */
const TASK_IDS_PER_READ = 500

/** What the named tasks reach, together. A member's session or work list asks for every task they own at once. */
export async function taskShareContents(scope: RecordScope, taskIds: readonly string[]): Promise<ShareResource[]> {
  const db = getDatabase()
  const contents: ShareResource[] = []
  for (let start = 0; start < taskIds.length; start += TASK_IDS_PER_READ) {
    const ids = sql.join(taskIds.slice(start, start + TASK_IDS_PER_READ).map((taskId) => sql`${taskId}`), sql`, `)
    const sessions = sessionIdRowSchema.array().parse(await db.all(sql`
      SELECT session_id FROM ${taskSessionLinks} WHERE ${scopeClause(scope)} AND task_id IN (${ids})
    `))
    const works = workIdRowSchema.array().parse(await db.all(sql`
      SELECT target_key FROM ${taskLinks} WHERE ${scopeClause(scope)} AND task_id IN (${ids}) AND kind = 'work'
    `))
    for (const row of sessions) contents.push({ kind: 'session', id: row.session_id })
    for (const row of works) contents.push({ kind: 'work', id: row.target_key })
  }
  return contents
}

/** The tasks a session or work is linked to, with the title the share list shows. */
export async function tasksContaining(scope: RecordScope, resource: ShareResource): Promise<ContainingTask[]> {
  const db = getDatabase()
  const rows = resource.kind === 'session'
    ? containingTaskRowSchema.array().parse(await db.all(sql`
        SELECT tasks.id AS task_id, tasks.title
        FROM ${taskSessionLinks}
        JOIN ${tasks} ON tasks.id = task_session_links.task_id
        WHERE ${scopeClause(scope, sql`tasks.organization_id`)} AND task_session_links.session_id = ${resource.id}
      `))
    : resource.kind === 'work'
      ? containingTaskRowSchema.array().parse(await db.all(sql`
          SELECT tasks.id AS task_id, tasks.title
          FROM ${taskLinks}
          JOIN ${tasks} ON tasks.id = task_links.task_id
          WHERE ${scopeClause(scope, sql`tasks.organization_id`)} AND task_links.kind = 'work' AND task_links.target_key = ${resource.id}
        `))
      : []
  return rows.map((row) => ({ taskId: row.task_id, title: row.title }))
}
