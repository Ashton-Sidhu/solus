import { z } from 'zod'
import type { ShareResource } from '@solus/contracts/sharing'
import { getDb } from '../db'
import { getDatabase } from '../db/database'
import type { ContainingTask } from '../sharing/share-manager'

/**
 * What a task's share reaches (docs/plans/multiplayer-sharing.md §3.4): the sessions
 * attempted under it and the works linked to it. The share manager asks these two
 * questions and joins nothing of the tasks domain itself.
 *
 * `ShareManager.roleFor` is synchronous — it runs inside the access check of
 * every RPC — so these two reads stay on the host's SQLite connection, where
 * the tasks tables are when SQLite is the engine. On Postgres the sharing
 * domain has not been ported, and a task's share reaches only its own page
 * until it is (docs/plans/cloud-service-model.md).
 */

const sessionIdRowSchema = z.object({ session_id: z.string() })
const workIdRowSchema = z.object({ target_key: z.string() })
const containingTaskRowSchema = z.object({ task_id: z.string(), title: z.string() })

export function taskShareContents(taskId: string): ShareResource[] {
  if (getDatabase().engine !== 'sqlite') return []
  const db = getDb()
  const sessions = sessionIdRowSchema.array().parse(
    db.prepare('SELECT session_id FROM task_session_links WHERE task_id = ?').all(taskId),
  )
  const works = workIdRowSchema.array().parse(
    db.prepare("SELECT target_key FROM task_links WHERE task_id = ? AND kind = 'work'").all(taskId),
  )
  return [
    ...sessions.map((row): ShareResource => ({ kind: 'session', id: row.session_id })),
    ...works.map((row): ShareResource => ({ kind: 'work', id: row.target_key })),
  ]
}

/** The tasks a session or work is linked to, with the title the share list shows. */
export function tasksContaining(resource: ShareResource): ContainingTask[] {
  if (getDatabase().engine !== 'sqlite') return []
  const db = getDb()
  const rows = resource.kind === 'session'
    ? containingTaskRowSchema.array().parse(db.prepare(`
        SELECT tasks.id AS task_id, tasks.title
        FROM task_session_links
        JOIN tasks ON tasks.id = task_session_links.task_id
        WHERE task_session_links.session_id = ?
      `).all(resource.id))
    : resource.kind === 'work'
      ? containingTaskRowSchema.array().parse(db.prepare(`
          SELECT tasks.id AS task_id, tasks.title
          FROM task_links
          JOIN tasks ON tasks.id = task_links.task_id
          WHERE task_links.kind = 'work' AND task_links.target_key = ?
        `).all(resource.id))
      : []
  return rows.map((row) => ({ taskId: row.task_id, title: row.title }))
}
