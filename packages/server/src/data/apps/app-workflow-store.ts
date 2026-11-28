import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { APP_RUN_STATES, appCallerSchema, type AppCaller, type AppRunState, type AppStepKind, type AppStepState } from '@solus/contracts/apps'
import { getDatabase, type Db } from '../../db/database'
import { appWorkflowRuns, appWorkflowSteps, apps } from './schema'

/**
 * The records of workflow runs (docs/plans/apps.md §8.3): a run, and the
 * receipt of each of its steps. A run that starts again answers a finished
 * step from its receipt.
 */

/** The finished runs an app keeps. */
export const MAX_FINISHED_RUNS_PER_APP = 500

const storedJsonSchema = z.json()
export type StoredJson = z.infer<typeof storedJsonSchema>

export interface AppRunRecord {
  id: string
  appId: string
  workflow: string
  input: StoredJson
  state: AppRunState
  key: string | null
  result: StoredJson
  error: string | null
  wakeAt: number | null
  startedBy: AppCaller
  interruptions: number
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  /** The version pinned to this run; set when the run starts, and updated to the active version on retry. */
  version: number | null
  /** When the owner dismissed the failure of the run. */
  dismissedAt: number | null
}

export interface AppStepRecord {
  runId: string
  name: string
  kind: AppStepKind
  state: AppStepState
  attempts: number
  result: StoredJson
  error: string | null
  wakeAt: number | null
  startedAt: number
  finishedAt: number | null
}

const nullableTimeSchema = z.union([z.null(), z.coerce.number()])

const runRowSchema = z.object({
  id: z.string(),
  app_id: z.string(),
  workflow: z.string(),
  input: z.string(),
  state: z.enum(APP_RUN_STATES),
  start_key: z.string().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  wake_at: nullableTimeSchema,
  started_by: z.string(),
  interruptions: z.coerce.number(),
  started_at: z.coerce.number(),
  updated_at: z.coerce.number(),
  finished_at: nullableTimeSchema,
  version: z.union([z.null(), z.coerce.number()]),
  dismissed_at: nullableTimeSchema,
})

function runFromRow(row: z.infer<typeof runRowSchema>): AppRunRecord {
  return {
    id: row.id,
    appId: row.app_id,
    workflow: row.workflow,
    input: storedJsonSchema.parse(JSON.parse(row.input)),
    state: row.state,
    key: row.start_key,
    result: row.result === null ? null : storedJsonSchema.parse(JSON.parse(row.result)),
    error: row.error,
    wakeAt: row.wake_at,
    startedBy: appCallerSchema.parse(JSON.parse(row.started_by)),
    interruptions: row.interruptions,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    version: row.version,
    dismissedAt: row.dismissed_at,
  }
}

const stepRowSchema = z.object({
  run_id: z.string(),
  name: z.string(),
  kind: z.enum(['do', 'sleep', 'query', 'mutation']),
  state: z.enum(['running', 'done', 'failed', 'sleeping']),
  attempts: z.coerce.number(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  wake_at: nullableTimeSchema,
  started_at: z.coerce.number(),
  finished_at: nullableTimeSchema,
})

function stepFromRow(row: z.infer<typeof stepRowSchema>): AppStepRecord {
  return {
    runId: row.run_id,
    name: row.name,
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    result: row.result === null ? null : storedJsonSchema.parse(JSON.parse(row.result)),
    error: row.error,
    wakeAt: row.wake_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export async function insertRun(record: AppRunRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${appWorkflowRuns} (id, app_id, workflow, input, state, start_key, result, error, wake_at, started_by, interruptions, started_at, updated_at, finished_at, version, dismissed_at)
    VALUES (
      ${record.id}, ${record.appId}, ${record.workflow}, ${JSON.stringify(record.input)}, ${record.state}, ${record.key},
      ${record.result === null ? null : JSON.stringify(record.result)}, ${record.error}, ${record.wakeAt}, ${JSON.stringify(record.startedBy)},
      ${record.interruptions}, ${record.startedAt}, ${record.updatedAt}, ${record.finishedAt}, ${record.version}, ${record.dismissedAt}
    )
  `)
}

/** Writes what changes in a run after its start. */
export async function saveRun(record: AppRunRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    UPDATE ${appWorkflowRuns} SET
      state = ${record.state}, result = ${record.result === null ? null : JSON.stringify(record.result)}, error = ${record.error === null ? null : record.error.slice(0, 2000)},
      wake_at = ${record.wakeAt}, interruptions = ${record.interruptions}, updated_at = ${record.updatedAt}, finished_at = ${record.finishedAt},
      version = ${record.version}, dismissed_at = ${record.dismissedAt}
    WHERE id = ${record.id}
  `)
}

export async function loadRun(runId: string, db: Db = getDatabase()): Promise<AppRunRecord | null> {
  const row = await db.get(sql`SELECT * FROM ${appWorkflowRuns} WHERE id = ${runId}`)
  return row ? runFromRow(runRowSchema.parse(row)) : null
}

/** The run a workflow of an app was started with one key for. */
export async function loadRunByKey(appId: string, workflow: string, key: string, db: Db = getDatabase()): Promise<AppRunRecord | null> {
  const row = await db.get(sql`SELECT * FROM ${appWorkflowRuns} WHERE app_id = ${appId} AND workflow = ${workflow} AND start_key = ${key}`)
  return row ? runFromRow(runRowSchema.parse(row)) : null
}

/** The newest runs of an app, of one state or of one workflow when given. */
export async function listRuns(appId: string, limit: number, filter: { state?: AppRunState; workflow?: string } = {}, db: Db = getDatabase()): Promise<AppRunRecord[]> {
  const where = [sql`app_id = ${appId}`]
  if (filter.state !== undefined) where.push(sql`state = ${filter.state}`)
  if (filter.workflow !== undefined) where.push(sql`workflow = ${filter.workflow}`)
  const rows = await db.all(sql`SELECT * FROM ${appWorkflowRuns} WHERE ${sql.join(where, sql` AND `)} ORDER BY started_at DESC, id DESC LIMIT ${limit}`)
  return z.array(runRowSchema).parse(rows).map(runFromRow)
}

/** Every run that is not at its end, of the apps that run: what the host starts again or wakes. A run of a stopped app waits for Start. */
export async function listOpenRuns(db: Db = getDatabase()): Promise<AppRunRecord[]> {
  const rows = await db.all(sql`
    SELECT app_workflow_runs.* FROM ${appWorkflowRuns}
    JOIN ${apps} ON apps.id = app_workflow_runs.app_id
    WHERE app_workflow_runs.state IN ('running', 'sleeping') AND apps.active_version IS NOT NULL AND apps.stopped = ${db.engine === 'postgres' ? false : 0}
    ORDER BY app_workflow_runs.started_at
  `)
  return z.array(runRowSchema).parse(rows).map(runFromRow)
}

/** The open runs of one app. */
export async function listOpenRunsOf(appId: string, db: Db = getDatabase()): Promise<AppRunRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${appWorkflowRuns} WHERE app_id = ${appId} AND state IN ('running', 'sleeping') ORDER BY started_at`)
  return z.array(runRowSchema).parse(rows).map(runFromRow)
}

/** The newest finished run of each workflow of an app: what says whether a workflow's last run failed. */
export async function lastFinishedRuns(appId: string, db: Db = getDatabase()): Promise<AppRunRecord[]> {
  const rows = await db.all(sql`
    SELECT * FROM ${appWorkflowRuns} WHERE app_id = ${appId} AND finished_at IS NOT NULL AND finished_at = (
      SELECT MAX(later.finished_at) FROM ${appWorkflowRuns} AS later WHERE later.app_id = ${appId} AND later.workflow = app_workflow_runs.workflow
    )
  `)
  return z.array(runRowSchema).parse(rows).map(runFromRow)
}

/** Deletes the finished runs of an app older than its newest `MAX_FINISHED_RUNS_PER_APP`, with their steps. */
export async function pruneRuns(appId: string, db: Db = getDatabase()): Promise<void> {
  await db.transaction(async (tx) => {
    const old = sql`
      SELECT id FROM ${appWorkflowRuns} WHERE app_id = ${appId} AND finished_at IS NOT NULL AND id NOT IN (
        SELECT id FROM ${appWorkflowRuns} WHERE app_id = ${appId} AND finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT ${MAX_FINISHED_RUNS_PER_APP}
      )
    `
    await tx.run(sql`DELETE FROM ${appWorkflowSteps} WHERE run_id IN (${old})`)
    await tx.run(sql`DELETE FROM ${appWorkflowRuns} WHERE id IN (${old})`)
  })
}

export async function listSteps(runId: string, db: Db = getDatabase()): Promise<AppStepRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${appWorkflowSteps} WHERE run_id = ${runId} ORDER BY started_at, name`)
  return z.array(stepRowSchema).parse(rows).map(stepFromRow)
}

export async function countSteps(runIds: readonly string[], db: Db = getDatabase()): Promise<Map<string, number>> {
  if (runIds.length === 0) return new Map()
  const rows = z.array(z.object({ run_id: z.string(), count: z.coerce.number() })).parse(await db.all(sql`
    SELECT run_id, COUNT(*) AS count FROM ${appWorkflowSteps} WHERE run_id IN (${sql.join(runIds.map((id) => sql`${id}`), sql`, `)}) GROUP BY run_id
  `))
  return new Map(rows.map((row) => [row.run_id, row.count]))
}

/** Writes one step's receipt: a new one, or the one that is there with its new state. */
export async function saveStep(record: AppStepRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${appWorkflowSteps} (run_id, name, kind, state, attempts, result, error, wake_at, started_at, finished_at)
    VALUES (
      ${record.runId}, ${record.name}, ${record.kind}, ${record.state}, ${record.attempts}, ${record.result === null ? null : JSON.stringify(record.result)},
      ${record.error === null ? null : record.error.slice(0, 2000)}, ${record.wakeAt}, ${record.startedAt}, ${record.finishedAt}
    )
    ON CONFLICT(run_id, name) DO UPDATE SET
      state = excluded.state, attempts = excluded.attempts, result = excluded.result, error = excluded.error,
      wake_at = excluded.wake_at, finished_at = excluded.finished_at
  `)
}

/** Removes the receipts of the steps that did not finish, so a run that starts again runs them again. */
export async function deleteUnfinishedSteps(runId: string, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`DELETE FROM ${appWorkflowSteps} WHERE run_id = ${runId} AND state IN ('failed', 'running')`)
}
