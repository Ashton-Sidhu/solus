import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { appCallerSchema, appDescriptorSchema, type AppCaller, type AppDescriptor, type AppVersionState } from '@solus/contracts/apps'
import type { Attribution } from '@solus/contracts/user'
import type { RecordScope } from '../../admission/principal'
import { getDatabase, type Db } from '../../db/database'
import { scopeClause } from '../scope'
import { attributionJson, hostAttribution, parseStoredAttribution } from '../stored-attribution'
import { appCalls, appSchedules, appVersions, apps } from './schema'

/**
 * The app records (docs/plans/apps.md §4.1): the app, its versions, the state
 * of its schedules, and its call log. Plain functions over the ported tables,
 * so the same code runs on SQLite and Postgres.
 */

/** The call log keeps the newest calls of each app. */
export const MAX_CALLS_PER_APP = 2000

export interface AppRecord {
  id: string
  organizationId: string
  ownerKey: string
  slug: string
  name: string
  description: string
  activeVersion: number | null
  stopped: boolean
  repository: string
  project: string | null
  createdBy: Attribution
  /** The webhook record of each webhook the app declares, by the declaration's name. */
  webhookIds: { [name: string]: string }
  createdAt: number
  updatedAt: number
}

export interface AppVersionRecord {
  appId: string
  number: number
  sourceCommit: string
  buildCommit: string
  descriptor: AppDescriptor
  hasBackend: boolean
  hasUi: boolean
  state: AppVersionState
  error: string | null
  message: string
  createdBy: Attribution
  createdAt: number
}

export interface AppScheduleRecord {
  appId: string
  name: string
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastOutcome: 'ok' | 'failed' | null
  lastError: string | null
}

export interface AppCallRecord {
  id: string
  appId: string
  version: number
  operation: string
  caller: AppCaller
  startedAt: number
  finishedAt: number | null
  outcome: 'running' | 'ok' | 'failed'
  error: string | null
}

const flagSchema = z.union([z.boolean(), z.number()]).transform((value) => value === true || value === 1)
const timeSchema = z.coerce.number()
const nullableTimeSchema = z.union([z.null(), z.coerce.number()])
const nullableNumberSchema = z.union([z.null(), z.coerce.number()])

function flag(db: Db, value: boolean): boolean | number {
  return db.engine === 'postgres' ? value : value ? 1 : 0
}

const appRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  created_by: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  active_version: nullableNumberSchema,
  stopped: flagSchema,
  repository: z.string(),
  project: z.string().nullable(),
  author: z.string(),
  webhook_ids: z.string(),
  created_at: timeSchema,
  updated_at: timeSchema,
})

function appFromRow(row: z.infer<typeof appRowSchema>): AppRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ownerKey: row.created_by,
    slug: row.slug,
    name: row.name,
    description: row.description,
    activeVersion: row.active_version,
    stopped: row.stopped,
    repository: row.repository,
    project: row.project,
    createdBy: parseStoredAttribution(row.author) ?? hostAttribution(),
    webhookIds: z.record(z.string(), z.string()).parse(JSON.parse(row.webhook_ids)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function insertApp(record: AppRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${apps} (id, organization_id, created_by, slug, name, description, active_version, stopped, repository, project, author, webhook_ids, created_at, updated_at)
    VALUES (
      ${record.id}, ${record.organizationId}, ${record.ownerKey}, ${record.slug}, ${record.name}, ${record.description}, ${record.activeVersion},
      ${flag(db, record.stopped)}, ${record.repository}, ${record.project}, ${attributionJson(record.createdBy)}, ${JSON.stringify(record.webhookIds)},
      ${record.createdAt}, ${record.updatedAt}
    )
  `)
}

/** Writes what changes after the first deploy. The slug, the owner, the organization, and the repository never change. */
export async function saveApp(record: AppRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    UPDATE ${apps} SET
      name = ${record.name},
      description = ${record.description},
      active_version = ${record.activeVersion},
      stopped = ${flag(db, record.stopped)},
      webhook_ids = ${JSON.stringify(record.webhookIds)},
      updated_at = ${record.updatedAt}
    WHERE id = ${record.id}
  `)
}

/** An app by its id or its slug, in a read scope. */
export async function loadApp(scope: RecordScope, idOrSlug: string, db: Db = getDatabase()): Promise<AppRecord | null> {
  const row = await db.get(sql`SELECT * FROM ${apps} WHERE ${scopeClause(scope)} AND (id = ${idOrSlug} OR slug = ${idOrSlug})`)
  return row ? appFromRow(appRowSchema.parse(row)) : null
}

export async function slugIsTaken(slug: string, db: Db = getDatabase()): Promise<boolean> {
  return (await db.get(sql`SELECT 1 AS taken FROM ${apps} WHERE slug = ${slug}`)) !== undefined
}

/** The apps of a read scope, the newest change first. */
export async function listApps(scope: RecordScope, db: Db = getDatabase()): Promise<AppRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${apps} WHERE ${scopeClause(scope)} ORDER BY updated_at DESC, id`)
  return z.array(appRowSchema).parse(rows).map(appFromRow)
}

export async function deleteApp(id: string, db: Db = getDatabase()): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.run(sql`DELETE FROM ${appCalls} WHERE app_id = ${id}`)
    await tx.run(sql`DELETE FROM ${appSchedules} WHERE app_id = ${id}`)
    await tx.run(sql`DELETE FROM ${appVersions} WHERE app_id = ${id}`)
    return (await tx.run(sql`DELETE FROM ${apps} WHERE id = ${id}`)).changes > 0
  })
}

// ─── Versions ───

const versionRowSchema = z.object({
  app_id: z.string(),
  number: z.coerce.number(),
  source_commit: z.string(),
  build_commit: z.string(),
  descriptor: z.string(),
  has_backend: flagSchema,
  has_ui: flagSchema,
  state: z.enum(['active', 'superseded', 'failed']),
  error: z.string().nullable(),
  message: z.string(),
  author: z.string(),
  created_at: timeSchema,
})

function versionFromRow(row: z.infer<typeof versionRowSchema>): AppVersionRecord {
  return {
    appId: row.app_id,
    number: row.number,
    sourceCommit: row.source_commit,
    buildCommit: row.build_commit,
    descriptor: appDescriptorSchema.parse(JSON.parse(row.descriptor)),
    hasBackend: row.has_backend,
    hasUi: row.has_ui,
    state: row.state,
    error: row.error,
    message: row.message,
    createdBy: parseStoredAttribution(row.author) ?? hostAttribution(),
    createdAt: row.created_at,
  }
}

export async function insertVersion(record: AppVersionRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${appVersions} (app_id, number, source_commit, build_commit, descriptor, has_backend, has_ui, state, error, message, author, created_at)
    VALUES (
      ${record.appId}, ${record.number}, ${record.sourceCommit}, ${record.buildCommit}, ${JSON.stringify(record.descriptor)},
      ${flag(db, record.hasBackend)}, ${flag(db, record.hasUi)}, ${record.state}, ${record.error}, ${record.message}, ${attributionJson(record.createdBy)}, ${record.createdAt}
    )
  `)
}

export async function loadVersion(appId: string, number: number, db: Db = getDatabase()): Promise<AppVersionRecord | null> {
  const row = await db.get(sql`SELECT * FROM ${appVersions} WHERE app_id = ${appId} AND number = ${number}`)
  return row ? versionFromRow(versionRowSchema.parse(row)) : null
}

/** The versions of an app, the newest first. */
export async function listVersions(appId: string, db: Db = getDatabase()): Promise<AppVersionRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${appVersions} WHERE app_id = ${appId} ORDER BY number DESC`)
  return z.array(versionRowSchema).parse(rows).map(versionFromRow)
}

export async function latestVersionNumber(appId: string, db: Db = getDatabase()): Promise<number | null> {
  const row = z.object({ number: nullableNumberSchema }).parse(await db.get(sql`SELECT MAX(number) AS number FROM ${appVersions} WHERE app_id = ${appId}`))
  return row.number
}

/** Makes one version the active one: the version before it is superseded, in the same transaction as the app's pointer. */
export async function activateVersion(app: AppRecord, number: number, db: Db = getDatabase()): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run(sql`UPDATE ${appVersions} SET state = 'superseded' WHERE app_id = ${app.id} AND state = 'active'`)
    await tx.run(sql`UPDATE ${appVersions} SET state = 'active', error = NULL WHERE app_id = ${app.id} AND number = ${number}`)
    await saveApp({ ...app, activeVersion: number }, tx)
  })
}

export async function failVersion(appId: string, number: number, error: string, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`UPDATE ${appVersions} SET state = 'failed', error = ${error.slice(0, 2000)} WHERE app_id = ${appId} AND number = ${number}`)
}

// ─── Schedules ───

const scheduleRowSchema = z.object({
  app_id: z.string(),
  name: z.string(),
  enabled: flagSchema,
  next_run_at: nullableTimeSchema,
  last_run_at: nullableTimeSchema,
  last_outcome: z.enum(['ok', 'failed']).nullable(),
  last_error: z.string().nullable(),
})

function scheduleFromRow(row: z.infer<typeof scheduleRowSchema>): AppScheduleRecord {
  return {
    appId: row.app_id,
    name: row.name,
    enabled: row.enabled,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastOutcome: row.last_outcome,
    lastError: row.last_error,
  }
}

export async function listSchedules(appId: string, db: Db = getDatabase()): Promise<AppScheduleRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${appSchedules} WHERE app_id = ${appId} ORDER BY name`)
  return z.array(scheduleRowSchema).parse(rows).map(scheduleFromRow)
}

export async function saveSchedule(record: AppScheduleRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${appSchedules} (app_id, name, enabled, next_run_at, last_run_at, last_outcome, last_error)
    VALUES (${record.appId}, ${record.name}, ${flag(db, record.enabled)}, ${record.nextRunAt}, ${record.lastRunAt}, ${record.lastOutcome}, ${record.lastError})
    ON CONFLICT(app_id, name) DO UPDATE SET
      enabled = excluded.enabled, next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at,
      last_outcome = excluded.last_outcome, last_error = excluded.last_error
  `)
}

export async function deleteSchedule(appId: string, name: string, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`DELETE FROM ${appSchedules} WHERE app_id = ${appId} AND name = ${name}`)
}

/** The schedules that are on, of apps that run, due at or before `now`. */
export async function listDueSchedules(now: number, db: Db = getDatabase()): Promise<AppScheduleRecord[]> {
  const rows = await db.all(sql`
    SELECT app_schedules.* FROM ${appSchedules}
    JOIN ${apps} ON apps.id = app_schedules.app_id
    WHERE app_schedules.enabled = ${flag(db, true)} AND apps.stopped = ${flag(db, false)} AND apps.active_version IS NOT NULL
      AND app_schedules.next_run_at IS NOT NULL AND app_schedules.next_run_at <= ${now}
    ORDER BY app_schedules.next_run_at
  `)
  return z.array(scheduleRowSchema).parse(rows).map(scheduleFromRow)
}

/** When the next schedule of a running app is due; null when none is. */
export async function nextScheduleDueAt(db: Db = getDatabase()): Promise<number | null> {
  const row = z.object({ due: nullableTimeSchema }).parse(await db.get(sql`
    SELECT MIN(app_schedules.next_run_at) AS due FROM ${appSchedules}
    JOIN ${apps} ON apps.id = app_schedules.app_id
    WHERE app_schedules.enabled = ${flag(db, true)} AND apps.stopped = ${flag(db, false)} AND apps.active_version IS NOT NULL
  `))
  return row.due
}

// ─── The call log ───

const callRowSchema = z.object({
  id: z.string(),
  app_id: z.string(),
  version: z.coerce.number(),
  operation: z.string(),
  caller: z.string(),
  started_at: timeSchema,
  finished_at: nullableTimeSchema,
  outcome: z.enum(['running', 'ok', 'failed']),
  error: z.string().nullable(),
})

function callFromRow(row: z.infer<typeof callRowSchema>): AppCallRecord {
  return {
    id: row.id,
    appId: row.app_id,
    version: row.version,
    operation: row.operation,
    caller: appCallerSchema.parse(JSON.parse(row.caller)),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    error: row.error,
  }
}

export async function insertCall(record: AppCallRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${appCalls} (id, app_id, version, operation, caller, started_at, finished_at, outcome, error)
    VALUES (${record.id}, ${record.appId}, ${record.version}, ${record.operation}, ${JSON.stringify(record.caller)}, ${record.startedAt}, ${record.finishedAt}, ${record.outcome}, ${record.error})
  `)
}

export async function finishCall(id: string, outcome: 'ok' | 'failed', error: string | null, finishedAt: number, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`UPDATE ${appCalls} SET outcome = ${outcome}, error = ${error === null ? null : error.slice(0, 2000)}, finished_at = ${finishedAt} WHERE id = ${id}`)
}

/** The newest calls of an app. */
export async function listCalls(appId: string, limit: number, db: Db = getDatabase()): Promise<AppCallRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${appCalls} WHERE app_id = ${appId} ORDER BY started_at DESC, id DESC LIMIT ${limit}`)
  return z.array(callRowSchema).parse(rows).map(callFromRow)
}

/** Deletes the calls of an app older than its newest `MAX_CALLS_PER_APP`. */
export async function pruneCalls(appId: string, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    DELETE FROM ${appCalls} WHERE app_id = ${appId} AND id NOT IN (
      SELECT id FROM ${appCalls} WHERE app_id = ${appId} ORDER BY started_at DESC, id DESC LIMIT ${MAX_CALLS_PER_APP}
    )
  `)
}

/** A call that was running when the host stopped did not finish. */
export async function failInterruptedCalls(at: number, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`UPDATE ${appCalls} SET outcome = 'failed', error = 'The host stopped before this call ended.', finished_at = ${at} WHERE outcome = 'running'`)
}

/** When each app was last called. */
export async function lastCallTimes(appIds: readonly string[], db: Db = getDatabase()): Promise<Map<string, number>> {
  if (appIds.length === 0) return new Map()
  const rows = z.array(z.object({ app_id: z.string(), at: timeSchema })).parse(await db.all(sql`
    SELECT app_id, MAX(started_at) AS at FROM ${appCalls} WHERE app_id IN (${sql.join(appIds.map((id) => sql`${id}`), sql`, `)}) GROUP BY app_id
  `))
  return new Map(rows.map((row) => [row.app_id, row.at]))
}
