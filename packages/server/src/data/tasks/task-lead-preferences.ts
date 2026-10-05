import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { executionPreferenceSnapshotSchema, type ExecutionPreferences, type ExecutionPreferenceSnapshot } from '@solus/contracts/settings'
import { getDatabase } from '../../db/database'
import { taskSessionLinks, tasks } from './schema'
import { jsonValue } from './task-store'

/**
 * The preferences a task keeps from the person who first led it (plans/018
 * §3.1): the lead's model, the workers' model, the lead instructions, and the
 * task autonomy. Every later run on the task — the lead woken in the background
 * included — uses these, so a person changing their defaults, or another person
 * writing to the lead, does not change a task already under way.
 */
const TASK_LEAD_PREFERENCE_KEYS = ['leadModel', 'workerModel', 'leadInstructions', 'agentTaskLifecyclePolicy'] as const

function leadPreferencesOf(preferences: ExecutionPreferences): ExecutionPreferences {
  const captured: ExecutionPreferences = {}
  if (preferences.leadModel !== undefined) captured.leadModel = preferences.leadModel
  if (preferences.workerModel !== undefined) captured.workerModel = preferences.workerModel
  if (preferences.leadInstructions !== undefined) captured.leadInstructions = preferences.leadInstructions
  if (preferences.agentTaskLifecyclePolicy !== undefined) captured.agentTaskLifecyclePolicy = preferences.agentTaskLifecyclePolicy
  return captured
}

/** The task's captured lead preferences; undefined before it was first led, or for a task this host does not hold. */
export async function taskLeadPreferences(taskId: string): Promise<ExecutionPreferenceSnapshot | undefined> {
  const row = z.object({ lead_preferences: z.string().nullable() }).nullish().parse(await getDatabase().get(sql`
    SELECT lead_preferences FROM ${tasks} WHERE id = ${taskId}
  `))
  return row ? jsonValue(row.lead_preferences, executionPreferenceSnapshotSchema) : undefined
}

/** The captured lead preferences of the task a session leads or works on; a session that only references a task has none. */
export async function taskLeadPreferencesOfSession(sessionId: string): Promise<ExecutionPreferenceSnapshot | undefined> {
  const row = z.object({ lead_preferences: z.string().nullable() }).nullish().parse(await getDatabase().get(sql`
    SELECT task.lead_preferences FROM ${taskSessionLinks} link
    JOIN ${tasks} task ON task.id = link.task_id
    WHERE link.session_id = ${sessionId} AND link.role <> 'referenced'
    ORDER BY link.linked_at DESC
    LIMIT 1
  `))
  return row ? jsonValue(row.lead_preferences, executionPreferenceSnapshotSchema) : undefined
}

/**
 * Captures the lead preferences of the person who first leads the task. Only the
 * first capture is kept; answers the task's snapshot as it stands after the call.
 */
export async function captureTaskLeadPreferences(taskId: string, preferences: ExecutionPreferences, now = Date.now()): Promise<ExecutionPreferenceSnapshot | undefined> {
  const snapshot: ExecutionPreferenceSnapshot = { capturedAt: now, preferences: leadPreferencesOf(preferences) }
  await getDatabase().run(sql`
    UPDATE ${tasks} SET lead_preferences = ${JSON.stringify(snapshot)}
    WHERE id = ${taskId} AND lead_preferences IS NULL
  `)
  return taskLeadPreferences(taskId)
}

/** The run's preferences with the task's captured lead preferences in place of the person's current ones. */
export function withTaskLeadPreferences(preferences: ExecutionPreferences | undefined, captured: ExecutionPreferenceSnapshot): ExecutionPreferences {
  const merged: ExecutionPreferences = { ...preferences }
  for (const key of TASK_LEAD_PREFERENCE_KEYS) delete merged[key]
  return { ...merged, ...captured.preferences }
}
