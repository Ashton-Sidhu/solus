import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { ShareResource } from '@solus/contracts/sharing'
import { getDatabase } from '../db/database'
import type { ContainingTask } from '../sharing/share-manager'
import { taskLinks, taskSessionLinks, tasks } from './schema'

/**
 * What a task's share reaches (docs/plans/multiplayer-sharing.md §3.4): the sessions
 * attempted under it and the works linked to it. The share manager asks these two
 * questions and joins nothing of the tasks domain itself.
 */

const sessionIdRowSchema = z.object({ session_id: z.string() })
const workIdRowSchema = z.object({ target_key: z.string() })
const containingTaskRowSchema = z.object({ task_id: z.string(), title: z.string() })

export async function taskShareContents(organizationId: string, taskId: string): Promise<ShareResource[]> {
  const db = getDatabase()
  const sessions = sessionIdRowSchema.array().parse(await db.all(sql`
    SELECT session_id FROM ${taskSessionLinks} WHERE organization_id = ${organizationId} AND task_id = ${taskId}
  `))
  const works = workIdRowSchema.array().parse(await db.all(sql`
    SELECT target_key FROM ${taskLinks} WHERE organization_id = ${organizationId} AND task_id = ${taskId} AND kind = 'work'
  `))
  return [
    ...sessions.map((row): ShareResource => ({ kind: 'session', id: row.session_id })),
    ...works.map((row): ShareResource => ({ kind: 'work', id: row.target_key })),
  ]
}

/** The tasks a session or work is linked to, with the title the share list shows. */
export async function tasksContaining(organizationId: string, resource: ShareResource): Promise<ContainingTask[]> {
  const db = getDatabase()
  const rows = resource.kind === 'session'
    ? containingTaskRowSchema.array().parse(await db.all(sql`
        SELECT tasks.id AS task_id, tasks.title
        FROM ${taskSessionLinks}
        JOIN ${tasks} ON tasks.id = task_session_links.task_id
        WHERE tasks.organization_id = ${organizationId} AND task_session_links.session_id = ${resource.id}
      `))
    : resource.kind === 'work'
      ? containingTaskRowSchema.array().parse(await db.all(sql`
          SELECT tasks.id AS task_id, tasks.title
          FROM ${taskLinks}
          JOIN ${tasks} ON tasks.id = task_links.task_id
          WHERE tasks.organization_id = ${organizationId} AND task_links.kind = 'work' AND task_links.target_key = ${resource.id}
        `))
      : []
  return rows.map((row) => ({ taskId: row.task_id, title: row.title }))
}
