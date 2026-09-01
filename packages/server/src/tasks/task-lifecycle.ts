import { withTx } from '../db'
import type { Task } from '@solus/contracts/task-types'
import { diffTaskEvents } from './task-events'
import { database, emitChanged, requireTask, taskFromRow } from './task-store'
import { markTaskFieldsDirty, notifyTaskSyncDirty } from './task-sync-store'

function lifecycleTask(taskId: string): Task {
  return taskFromRow(requireTask(taskId, database()))
}

export async function markTaskRead(taskId: string, read: boolean): Promise<Task> {
  const now = Date.now()
  const task = withTx(() => {
    const db = database()
    requireTask(taskId, db)
    db.prepare('UPDATE tasks SET last_read_at = ? WHERE id = ?')
      .run(read ? now : null, taskId)
    return lifecycleTask(taskId)
  })
  emitChanged()
  return task
}

/** A closed task returns to active work when its linked conversation receives a
 * new prompt, because the user has started a new turn. This is a separate
 * command because a follow-up prompt does not otherwise write task state on the
 * task's host. */
export async function recordTaskActivity(taskId: string): Promise<Task> {
  let syncDirty = false
  const task = withTx(() => {
    const db = database()
    const existing = requireTask(taskId, db)
    if (existing.status === 'done' || existing.status === 'dropped') {
      const now = Date.now()
      db.prepare(`
        UPDATE tasks SET status = 'in_progress', done_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, taskId)
      const updated = requireTask(taskId, db)
      diffTaskEvents(db, taskId, existing, updated, { actor: 'user' }, now)
      syncDirty = markTaskFieldsDirty(db, taskId, ['status'])
    }
    return lifecycleTask(taskId)
  })
  emitChanged()
  if (syncDirty) notifyTaskSyncDirty(taskId)
  return task
}
