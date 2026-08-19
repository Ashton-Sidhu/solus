import { withTx } from '../db'
import type { DatabaseSync } from 'node:sqlite'
import type { Task, TaskSnoozeInput } from '@solus/contracts/task-types'
import { appendTaskEvent, diffTaskEvents } from './task-events'
import { database, emitChanged, requireTask, taskFromRow } from './task-store'
import { markTaskFieldsDirty, notifyTaskSyncDirty } from './task-sync-store'

function lifecycleTask(taskId: string): Task {
  return taskFromRow(requireTask(taskId, database()))
}

/** Meaningful work wakes a snoozed task without changing its workflow status. */
export function wakeTaskForActivity(db: DatabaseSync, taskId: string): void {
  db.prepare(`
    UPDATE tasks SET
      snoozed_until = NULL,
      snoozed_at = NULL,
      snooze_note = NULL
    WHERE id = ?
  `).run(taskId)
}

export async function snoozeTask(taskId: string, input: TaskSnoozeInput): Promise<Task> {
  const now = Date.now()
  if (input.until !== null && (!Number.isFinite(input.until) || input.until <= now)) {
    throw new Error('Snooze time must be in the future.')
  }
  const note = input.note?.trim() || null
  const effectiveUntil = input.until ?? now
  const task = withTx(() => {
    const db = database()
    const existing = requireTask(taskId, db)
    if (input.until !== null && (existing.status === 'done' || existing.status === 'dropped')) {
      throw new Error('Completed or dropped tasks must be reopened before snoozing.')
    }
    db.prepare(`
      UPDATE tasks SET
        snoozed_until = ?,
        snoozed_at = ?,
        snooze_note = CASE WHEN ? IS NULL THEN snooze_note ELSE ? END
      WHERE id = ?
    `).run(effectiveUntil, input.until === null ? null : now, input.until, note, taskId)
    appendTaskEvent(db, taskId, {
      kind: input.until === null ? 'woke' : 'snoozed',
      actor: 'user',
      to: input.until === null ? null : String(input.until),
      targetTitle: note,
    }, now)
    return lifecycleTask(taskId)
  })
  emitChanged()
  return task
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

/** Wake a task when its linked conversation receives a new prompt. A closed
 * task also returns to active work because the user has started a new turn.
 * This is a separate command because a follow-up prompt does not otherwise
 * write task state on the task's host. */
export async function recordTaskActivity(taskId: string): Promise<Task> {
  let syncDirty = false
  const task = withTx(() => {
    const db = database()
    const existing = requireTask(taskId, db)
    wakeTaskForActivity(db, taskId)
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
