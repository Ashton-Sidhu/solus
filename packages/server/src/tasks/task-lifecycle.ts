import { sql } from 'drizzle-orm'
import type { Task } from '@solus/contracts/task-types'
import type { Db } from '../db/database'
import { diffTaskEvents } from './task-events'
import { tasks } from './schema'
import { database, emitChanged, requireTask, taskFromRow } from './task-store'
import { markTaskFieldsDirty, notifyTaskSyncDirty } from './task-sync-store'

async function lifecycleTask(organizationId: string, taskId: string, db: Db): Promise<Task> {
  return taskFromRow(await requireTask(organizationId, taskId, db))
}

export async function markTaskRead(organizationId: string, taskId: string, read: boolean): Promise<Task> {
  const now = Date.now()
  const task = await database().transaction(async (db) => {
    await requireTask(organizationId, taskId, db)
    await db.run(sql`UPDATE ${tasks} SET last_read_at = ${read ? now : null} WHERE id = ${taskId}`)
    return lifecycleTask(organizationId, taskId, db)
  })
  emitChanged()
  return task
}

/** A closed task returns to active work when its linked conversation receives a
 * new prompt, because the user has started a new turn. This is a separate
 * command because a follow-up prompt does not otherwise write task state on the
 * task's host. */
export async function recordTaskActivity(organizationId: string, taskId: string): Promise<Task> {
  let syncDirty = false
  const task = await database().transaction(async (db) => {
    const existing = await requireTask(organizationId, taskId, db)
    if (existing.status === 'done' || existing.status === 'dropped') {
      const now = Date.now()
      await db.run(sql`
        UPDATE ${tasks} SET status = 'in_progress', done_at = NULL, updated_at = ${now}
        WHERE id = ${taskId}
      `)
      const updated = await requireTask(organizationId, taskId, db)
      await diffTaskEvents(db, organizationId, taskId, existing, updated, { actor: 'user' }, now)
      syncDirty = await markTaskFieldsDirty(db, taskId, ['status'])
    }
    return lifecycleTask(organizationId, taskId, db)
  })
  emitChanged()
  if (syncDirty) notifyTaskSyncDirty(organizationId, taskId)
  return task
}
