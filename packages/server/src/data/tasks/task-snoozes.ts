import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { TaskSnooze } from '@solus/contracts/task-types'
import { afterDatabaseCommit } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { personalResourceState } from '../personal-state/schema'
import { assertTaskKey, database } from './task-store'

/**
 * A person's snoozes of tasks (docs/task-snooze.md): their `personal_resource_state`
 * rows of kind `task`, by task key. A snooze is an attachment: it needs no copy
 * of the task on this host, and it is in the organization of the person who
 * made it. A snooze is that person's own view: it hides the task
 * from their task lists until the wake time, and nobody else's. It does not
 * change the task, so it writes no task activity, emits no `tasks.invalidated`,
 * and never travels with the task record. Waking deletes the row; an expired
 * snooze stays until woken, so a client can say the task woke.
 */

const snoozeRowSchema = z.object({
  resource_id: z.string(),
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
  const snooze: TaskSnooze = { taskId: row.resource_id, snoozedUntil: row.snoozed_until }
  if (row.snooze_note !== null) snooze.snoozeNote = row.snooze_note
  return snooze
}

/**
 * Snooze a task for one person until a wake time, or wake it now with `until`
 * null. `organizationId` is the person's own. Answers the person's snooze
 * after the write: null once it is woken.
 */
export async function snoozeTaskFor(
  organizationId: string,
  personKey: string,
  taskId: string,
  until: number | null,
  note = '',
): Promise<TaskSnooze | null> {
  assertTaskKey(taskId)
  const snooze = await database().transaction(async (db) => {
    if (until === null) {
      await db.run(sql`
        DELETE FROM ${personalResourceState}
        WHERE organization_id = ${organizationId} AND resource_kind = 'task' AND resource_id = ${taskId} AND created_by = ${personKey}
      `)
      return null
    }
    const snoozeNote = note.trim() || null
    await db.run(sql`
      INSERT INTO ${personalResourceState} (organization_id, resource_kind, resource_id, created_by, snoozed_until, snooze_note)
      VALUES (${organizationId}, 'task', ${taskId}, ${personKey}, ${until}, ${snoozeNote})
      ON CONFLICT (organization_id, resource_kind, resource_id, created_by) DO UPDATE SET
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

/** One person's snoozes of the tasks they can read in `scope`, soonest wake first. */
export async function readTaskSnoozes(scope: RecordScope, personKey: string): Promise<TaskSnooze[]> {
  const rows = snoozeRowSchema.array().parse(await database().all(sql`
    SELECT resource_id, snoozed_until, snooze_note FROM ${personalResourceState}
    WHERE created_by = ${personKey} AND resource_kind = 'task' AND snoozed_until IS NOT NULL
      AND ${scopeClause(scope, sql`personal_resource_state.organization_id`)}
    ORDER BY snoozed_until, resource_id
  `))
  return rows.map(snoozeFromRow)
}
