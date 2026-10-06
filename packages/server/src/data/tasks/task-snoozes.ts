import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { TaskSnooze } from '@solus/contracts/task-types'
import { afterDatabaseCommit } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { taskSnoozes } from './schema'
import { database, requireTask } from './task-store'

/**
 * A person's snoozes of tasks (docs/task-snooze.md). A snooze is that person's
 * own view: it hides the task from their task lists until the wake time, and
 * nobody else's. It does not change the task, so it writes no task activity,
 * emits no `tasks.invalidated`, and never travels with the task record.
 */

const snoozeRowSchema = z.object({
  task_id: z.string(),
  snoozed_until: z.coerce.number(),
  snooze_note: z.string().nullable(),
})

/** Whose snoozes changed, so only that person's connections hear it. */
export interface TaskSnoozesChange {
  personKey: string
  organizationId: string
}

type ChangeListener = (change: TaskSnoozesChange) => void
const listeners = new Set<ChangeListener>()

/** Hear each committed change to one person's snoozes. */
export function onTaskSnoozesChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snoozeFromRow(row: z.infer<typeof snoozeRowSchema>): TaskSnooze {
  const snooze: TaskSnooze = { taskId: row.task_id, snoozedUntil: row.snoozed_until }
  if (row.snooze_note !== null) snooze.snoozeNote = row.snooze_note
  return snooze
}

/**
 * Snooze a task for one person until a wake time, or wake it now with `until`
 * null. The person must be able to read the task in `scope`. Answers the
 * person's snooze after the write: null once it is woken.
 */
export async function snoozeTaskFor(
  scope: RecordScope,
  personKey: string,
  taskId: string,
  until: number | null,
  note = '',
): Promise<TaskSnooze | null> {
  let organizationId = ''
  const snooze = await database().transaction(async (db) => {
    organizationId = (await requireTask(scope, taskId, db)).organization_id
    if (until === null) {
      await db.run(sql`DELETE FROM ${taskSnoozes} WHERE task_id = ${taskId} AND person_key = ${personKey}`)
      return null
    }
    const snoozeNote = note.trim() || null
    await db.run(sql`
      INSERT INTO ${taskSnoozes} (task_id, person_key, snoozed_until, snooze_note, organization_id)
      VALUES (${taskId}, ${personKey}, ${until}, ${snoozeNote}, ${organizationId})
      ON CONFLICT (task_id, person_key) DO UPDATE SET
        snoozed_until = excluded.snoozed_until, snooze_note = excluded.snooze_note
    `)
    const snooze: TaskSnooze = { taskId, snoozedUntil: until }
    if (snoozeNote) snooze.snoozeNote = snoozeNote
    return snooze
  })
  const change = { personKey, organizationId }
  void afterDatabaseCommit(async () => {
    for (const listener of listeners) listener(change)
  })
  return snooze
}

/**
 * One person's snoozes of the tasks they can read in `scope`. A snooze whose
 * wake time has passed stays until the person wakes it, so a client can show
 * that the task woke.
 */
export async function readTaskSnoozes(scope: RecordScope, personKey: string): Promise<TaskSnooze[]> {
  const rows = snoozeRowSchema.array().parse(await database().all(sql`
    SELECT task_id, snoozed_until, snooze_note FROM ${taskSnoozes}
    WHERE person_key = ${personKey} AND ${scopeClause(scope, sql`task_snoozes.organization_id`)}
    ORDER BY snoozed_until, task_id
  `))
  return rows.map(snoozeFromRow)
}
