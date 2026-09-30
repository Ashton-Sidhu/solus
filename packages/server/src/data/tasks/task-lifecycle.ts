import { sql } from 'drizzle-orm'
import type { Attribution } from '@solus/contracts/user'
import type { Task } from '@solus/contracts/task-types'
import type { Db } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { diffTaskActivity } from './task-activity'
import { tasks } from './schema'
import { database, emitChanged, requireTask, taskFromRow } from './task-store'
import { markTaskFieldsDirty, notifyTaskSyncDirty } from './task-sync-store'

async function lifecycleTask(scope: RecordScope, taskId: string, db: Db): Promise<Task> {
  return taskFromRow(await requireTask(scope, taskId, db))
}

export async function markTaskRead(scope: RecordScope, taskId: string, read: boolean): Promise<Task> {
  const now = Date.now()
  const task = await database().transaction(async (db) => {
    await requireTask(scope, taskId, db)
    await db.run(sql`UPDATE ${tasks} SET last_read_at = ${read ? now : null} WHERE id = ${taskId}`)
    return lifecycleTask(scope, taskId, db)
  })
  emitChanged(taskId)
  return task
}

/** A closed task returns to active work when its linked conversation receives a
 * new prompt, because the user has started a new turn. This is a separate
 * command because a follow-up prompt does not otherwise write task state on the
 * task's host. */
export async function recordTaskActivity(scope: RecordScope, taskId: string, by: Attribution): Promise<Task> {
  let syncDirty = false
  let reopened = false
  let organizationId = ''
  const task = await database().transaction(async (db) => {
    const existing = await requireTask(scope, taskId, db)
    organizationId = existing.organization_id
    if (existing.status === 'done' || existing.status === 'dropped') {
      reopened = true
      const now = Date.now()
      await db.run(sql`
        UPDATE ${tasks} SET status = 'in_progress', done_at = NULL, updated_at = ${now}
        WHERE id = ${taskId}
      `)
      const updated = await requireTask(scope, taskId, db)
      // The event is the task's own, so it lands in the task's organization.
      await diffTaskActivity(db, organizationId, taskId, existing, updated, by, now)
      syncDirty = await markTaskFieldsDirty(db, taskId, ['status'])
    }
    return lifecycleTask(scope, taskId, db)
  })
  // Every follow-up prompt records activity; only a reopen changes the task.
  if (reopened) emitChanged(taskId)
  if (syncDirty) notifyTaskSyncDirty(organizationId, taskId)
  return task
}
