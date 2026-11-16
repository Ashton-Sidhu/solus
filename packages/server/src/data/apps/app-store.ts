import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { appCallerSchema, appDescriptorSchema, appLogLineSchema, appSpanSchema, type AppCallKind, type AppCallOutcome, type AppCallTerm, type AppCaller, type AppCallerKind, type AppDescriptor, type AppLogLine, type AppSpan, type AppVersionActivation, type AppVersionState } from '@solus/contracts/apps'
import { attributionSchema, type Attribution } from '@solus/contracts/user'
import type { RecordScope } from '../../admission/principal'
import { getDatabase, type Db } from '../../db/database'
import { scopeClause } from '../scope'
import { attributionJson, hostAttribution, parseStoredAttribution } from '../stored-attribution'
import { appCalls, appFiles, appSchedules, appSignalActions, appSignals, appVersions, appWorkflowRuns, appWorkflowSteps, apps } from './schema'

/**
 * The app records (docs/plans/apps.md §4.1): the app, its versions, the state
 * of its schedules, and its call log. Its files, its workflow runs, and its
 * signals have stores of their own beside this one. Plain functions over the
 * ported tables, so the same code runs on SQLite and Postgres.
 */

/** The call log keeps the newest calls of each app. */
export const MAX_CALLS_PER_APP = 2000

export interface AppRecord {
  id: string
  organizationId: string
  ownerKey: string
  slug: string
  /** The manifest's name and description: each deploy writes them. */
  name: string
  description: string
  /** What the owner named and described the app; null shows the manifest's. */
  customName: string | null
  customDescription: string | null
  /** The hue (0–359) of the app's tile; null takes one from the app's id. */
  colorHue: number | null
  activeVersion: number | null
  stopped: boolean
  agentAccess: boolean
  repository: string
  /** The newest revision; null until the first save wrote it. */
  latestRevision: string | null
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
  /** The end of the text of the host's build; null for a version the host did not build. */
  buildLog: string | null
  buildMs: number | null
  message: string
  createdBy: Attribution
  createdAt: number
  activations: AppVersionActivation[]
}

/** A version keeps its newest activations: enough for any history a person reads. */
export const MAX_ACTIVATIONS_PER_VERSION = 50

const activationsSchema = z.array(z.object({ at: z.number(), by: attributionSchema, previous: z.number().nullable() }))

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
  kind: AppCallKind
  operation: string
  caller: AppCaller
  startedAt: number
  finishedAt: number | null
  outcome: AppCallOutcome
  error: string | null
  errorStack: string | null
  /** The start of the input as JSON text. */
  input: string | null
  inputTruncated: boolean
  resultBytes: number | null
  logs: AppLogLine[]
  logsTruncated: boolean
  spans: AppSpan[]
  runId: string | null
  traceId: string | null
  spanId: string | null
}

/** What a call's end writes over its row. */
export interface AppCallEnd {
  outcome: 'ok' | 'failed'
  error: string | null
  errorStack: string | null
  resultBytes: number | null
  logs: AppLogLine[]
  logsTruncated: boolean
  spans: AppSpan[]
  finishedAt: number
}

/** The filters of a read of the call log. */
export interface AppCallFilter {
  operation?: string
  outcome?: AppCallOutcome
  callerKind?: AppCallerKind
  runId?: string
  /** Only calls that started before this time. */
  before?: number
  /** Only calls that hold this text, in any case, in their operation, caller, error, input, or log lines. */
  search?: string
  kind?: AppCallKind
  /** Only calls that started at this time or later. */
  since?: number
  /** Only calls that started before this time: the end of a time range. */
  until?: number
  /** Every group must match; a group matches when one of its terms does. */
  match?: AppCallTerm[][]
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
  custom_name: z.string().nullable(),
  custom_description: z.string().nullable(),
  color_hue: nullableNumberSchema,
  active_version: nullableNumberSchema,
  stopped: flagSchema,
  agent_access: flagSchema,
  repository: z.string(),
  latest_revision: z.string().nullable(),
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
    customName: row.custom_name,
    customDescription: row.custom_description,
    colorHue: row.color_hue,
    activeVersion: row.active_version,
    stopped: row.stopped,
    agentAccess: row.agent_access,
    repository: row.repository,
    latestRevision: row.latest_revision,
    project: row.project,
    createdBy: parseStoredAttribution(row.author) ?? hostAttribution(),
    webhookIds: z.record(z.string(), z.string()).parse(JSON.parse(row.webhook_ids)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function insertApp(record: AppRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${apps} (id, organization_id, created_by, slug, name, description, custom_name, custom_description, color_hue, active_version, stopped, agent_access, repository, latest_revision, project, author, webhook_ids, created_at, updated_at)
    VALUES (
      ${record.id}, ${record.organizationId}, ${record.ownerKey}, ${record.slug}, ${record.name}, ${record.description}, ${record.customName}, ${record.customDescription}, ${record.colorHue}, ${record.activeVersion},
      ${flag(db, record.stopped)}, ${flag(db, record.agentAccess)}, ${record.repository}, ${record.latestRevision}, ${record.project}, ${attributionJson(record.createdBy)}, ${JSON.stringify(record.webhookIds)},
      ${record.createdAt}, ${record.updatedAt}
    )
  `)
}

/** Writes what changes after the first save. The slug, the owner, the organization, and the repository never change. */
export async function saveApp(record: AppRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    UPDATE ${apps} SET
      name = ${record.name},
      description = ${record.description},
      custom_name = ${record.customName},
      custom_description = ${record.customDescription},
      color_hue = ${record.colorHue},
      active_version = ${record.activeVersion},
      stopped = ${flag(db, record.stopped)},
      agent_access = ${flag(db, record.agentAccess)},
      latest_revision = ${record.latestRevision},
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
    await tx.run(sql`DELETE FROM ${appSignalActions} WHERE app_id = ${id}`)
    await tx.run(sql`DELETE FROM ${appSignals} WHERE app_id = ${id}`)
    await tx.run(sql`DELETE FROM ${appWorkflowSteps} WHERE run_id IN (SELECT id FROM ${appWorkflowRuns} WHERE app_id = ${id})`)
    await tx.run(sql`DELETE FROM ${appWorkflowRuns} WHERE app_id = ${id}`)
    await tx.run(sql`DELETE FROM ${appFiles} WHERE app_id = ${id}`)
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
  state: z.enum(['building', 'active', 'superseded', 'failed']),
  error: z.string().nullable(),
  build_log: z.string().nullable(),
  build_ms: nullableNumberSchema,
  message: z.string(),
  author: z.string(),
  created_at: timeSchema,
  activations: z.string(),
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
    buildLog: row.build_log,
    buildMs: row.build_ms,
    message: row.message,
    createdBy: parseStoredAttribution(row.author) ?? hostAttribution(),
    createdAt: row.created_at,
    activations: activationsSchema.parse(JSON.parse(row.activations)),
  }
}

export async function insertVersion(record: AppVersionRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${appVersions} (app_id, number, source_commit, build_commit, descriptor, has_backend, has_ui, state, error, build_log, build_ms, message, author, created_at, activations)
    VALUES (
      ${record.appId}, ${record.number}, ${record.sourceCommit}, ${record.buildCommit}, ${JSON.stringify(record.descriptor)},
      ${flag(db, record.hasBackend)}, ${flag(db, record.hasUi)}, ${record.state}, ${record.error}, ${record.buildLog}, ${record.buildMs}, ${record.message},
      ${attributionJson(record.createdBy)}, ${record.createdAt}, ${JSON.stringify(record.activations)}
    )
  `)
}

/** What a build that ended writes over the row a deploy made when the build started. The state stays `building` until the version starts. */
export async function saveVersionBuild(record: Pick<AppVersionRecord, 'appId' | 'number' | 'buildCommit' | 'descriptor' | 'hasBackend' | 'hasUi' | 'buildLog' | 'buildMs'>, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    UPDATE ${appVersions} SET
      build_commit = ${record.buildCommit}, descriptor = ${JSON.stringify(record.descriptor)}, has_backend = ${flag(db, record.hasBackend)},
      has_ui = ${flag(db, record.hasUi)}, build_log = ${record.buildLog}, build_ms = ${record.buildMs}
    WHERE app_id = ${record.appId} AND number = ${record.number}
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

/**
 * Makes one version the active one: the version before it is superseded, in
 * the same transaction as the app's pointer. The version keeps when, by whom,
 * and over which version it became active, so a rollback has a history.
 */
export async function activateVersion(app: AppRecord, number: number, by: Attribution, db: Db = getDatabase()): Promise<void> {
  await db.transaction(async (tx) => {
    const row = z.object({ activations: z.string() }).optional().parse(await tx.get(sql`SELECT activations FROM ${appVersions} WHERE app_id = ${app.id} AND number = ${number}`))
    const activations = row ? activationsSchema.parse(JSON.parse(row.activations)) : []
    activations.push({ at: Date.now(), by, previous: app.activeVersion })
    await tx.run(sql`UPDATE ${appVersions} SET state = 'superseded' WHERE app_id = ${app.id} AND state = 'active'`)
    await tx.run(sql`
      UPDATE ${appVersions} SET state = 'active', error = NULL, activations = ${JSON.stringify(activations.slice(-MAX_ACTIVATIONS_PER_VERSION))}
      WHERE app_id = ${app.id} AND number = ${number}
    `)
    await saveApp({ ...app, activeVersion: number }, tx)
  })
}

export async function failVersion(appId: string, number: number, error: string, build: { log: string | null; ms: number | null } | null = null, db: Db = getDatabase()): Promise<void> {
  if (build) await db.run(sql`UPDATE ${appVersions} SET build_log = ${build.log}, build_ms = ${build.ms} WHERE app_id = ${appId} AND number = ${number}`)
  await db.run(sql`UPDATE ${appVersions} SET state = 'failed', error = ${error.slice(0, 2000)} WHERE app_id = ${appId} AND number = ${number}`)
}

/** A version that was building when the host stopped did not finish. */
export async function failInterruptedBuilds(db: Db = getDatabase()): Promise<void> {
  await db.run(sql`UPDATE ${appVersions} SET state = 'failed', error = 'The host stopped during the build. Deploy the revision again.' WHERE state = 'building'`)
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
  kind: z.enum(['operation', 'model']),
  caller: z.string(),
  started_at: timeSchema,
  finished_at: nullableTimeSchema,
  outcome: z.enum(['running', 'ok', 'failed']),
  error: z.string().nullable(),
  error_stack: z.string().nullable(),
  input: z.string().nullable(),
  input_truncated: flagSchema,
  result_bytes: nullableNumberSchema,
  logs: z.string(),
  logs_truncated: flagSchema,
  spans: z.string(),
  run_id: z.string().nullable(),
  trace_id: z.string().nullable(),
  span_id: z.string().nullable(),
})

const logLinesSchema = z.array(appLogLineSchema)
const spansSchema = z.array(appSpanSchema)

function callFromRow(row: z.infer<typeof callRowSchema>): AppCallRecord {
  return {
    id: row.id,
    appId: row.app_id,
    version: row.version,
    kind: row.kind,
    operation: row.operation,
    caller: appCallerSchema.parse(JSON.parse(row.caller)),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    error: row.error,
    errorStack: row.error_stack,
    input: row.input,
    inputTruncated: row.input_truncated,
    resultBytes: row.result_bytes,
    logs: logLinesSchema.parse(JSON.parse(row.logs)),
    logsTruncated: row.logs_truncated,
    spans: spansSchema.parse(JSON.parse(row.spans)),
    runId: row.run_id,
    traceId: row.trace_id,
    spanId: row.span_id,
  }
}

/** A call that starts: its row has no log line and no span yet. */
export async function insertCall(record: Pick<AppCallRecord, 'id' | 'appId' | 'version' | 'kind' | 'operation' | 'caller' | 'startedAt' | 'input' | 'inputTruncated' | 'runId' | 'traceId' | 'spanId'>, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${appCalls} (id, app_id, version, kind, operation, caller, caller_kind, started_at, outcome, input, input_truncated, run_id, trace_id, span_id)
    VALUES (
      ${record.id}, ${record.appId}, ${record.version}, ${record.kind}, ${record.operation}, ${JSON.stringify(record.caller)}, ${record.caller.kind}, ${record.startedAt}, 'running',
      ${record.input}, ${flag(db, record.inputTruncated)}, ${record.runId}, ${record.traceId}, ${record.spanId}
    )
  `)
}

export async function finishCall(id: string, end: AppCallEnd, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    UPDATE ${appCalls} SET
      outcome = ${end.outcome}, error = ${end.error === null ? null : end.error.slice(0, 2000)}, error_stack = ${end.errorStack === null ? null : end.errorStack.slice(0, 8000)},
      result_bytes = ${end.resultBytes}, logs = ${JSON.stringify(end.logs)}, logs_truncated = ${flag(db, end.logsTruncated)}, spans = ${JSON.stringify(end.spans)},
      finished_at = ${end.finishedAt}
    WHERE id = ${id}
  `)
}

/** A LIKE pattern that finds `text` in any case: a wildcard of SQL in it is text to find. */
function containsPattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

// The log lines and the caller are JSON text; the host keeps at most 2,000 calls of an app, so a scan is cheap.
const callText = sql`LOWER(operation || ' ' || caller || ' ' || COALESCE(error, '') || ' ' || COALESCE(input, '') || ' ' || logs)`

/** One term of a query as SQL. A version that is not a whole number matches no call. */
function termSql(term: AppCallTerm): SQL {
  const value = term.value.trim()
  switch (term.field) {
    case 'operation': return sql`LOWER(operation) = ${value.toLowerCase()}`
    case 'caller': return sql`caller_kind = ${value.toLowerCase()}`
    case 'outcome': return sql`outcome = ${value.toLowerCase()}`
    case 'version': return /^v?\d+$/i.test(value) ? sql`version = ${Number(value.replace(/^v/i, ''))}` : sql`1 = 0`
    case 'run': return sql`run_id = ${value}`
    case 'error': return sql`LOWER(COALESCE(error, '')) LIKE ${containsPattern(value)} ESCAPE '\\'`
    case 'text': return sql`${callText} LIKE ${containsPattern(value)} ESCAPE '\\'`
  }
}

/** What a filter keeps of the calls of an app, as the WHERE of a read. */
function callWhere(appId: string, filter: AppCallFilter): SQL {
  const where = [sql`app_id = ${appId}`]
  if (filter.operation !== undefined) where.push(sql`operation = ${filter.operation}`)
  if (filter.outcome !== undefined) where.push(sql`outcome = ${filter.outcome}`)
  if (filter.callerKind !== undefined) where.push(sql`caller_kind = ${filter.callerKind}`)
  if (filter.runId !== undefined) where.push(sql`run_id = ${filter.runId}`)
  if (filter.kind !== undefined) where.push(sql`kind = ${filter.kind}`)
  if (filter.since !== undefined) where.push(sql`started_at >= ${filter.since}`)
  if (filter.before !== undefined) where.push(sql`started_at < ${filter.before}`)
  if (filter.until !== undefined) where.push(sql`started_at < ${filter.until}`)
  if (filter.search !== undefined) where.push(sql`${callText} LIKE ${containsPattern(filter.search)} ESCAPE '\\'`)
  for (const group of filter.match ?? []) {
    if (group.length > 0) where.push(sql`(${sql.join(group.map(termSql), sql` OR `)})`)
  }
  return sql.join(where, sql` AND `)
}

/** The newest calls of an app that pass the filter. */
export async function listCalls(appId: string, limit: number, filter: AppCallFilter = {}, db: Db = getDatabase()): Promise<AppCallRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${appCalls} WHERE ${callWhere(appId, filter)} ORDER BY started_at DESC, id DESC LIMIT ${limit}`)
  return z.array(callRowSchema).parse(rows).map(callFromRow)
}

export async function loadCall(appId: string, callId: string, db: Db = getDatabase()): Promise<AppCallRecord | null> {
  const row = await db.get(sql`SELECT * FROM ${appCalls} WHERE app_id = ${appId} AND id = ${callId}`)
  return row ? callFromRow(callRowSchema.parse(row)) : null
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

/** How many calls each app had since a time, and how many of them failed. */
export async function callCountsSince(appIds: readonly string[], since: number, db: Db = getDatabase()): Promise<Map<string, { calls: number; failed: number }>> {
  if (appIds.length === 0) return new Map()
  const rows = z.array(z.object({ app_id: z.string(), calls: z.coerce.number(), failed: z.coerce.number() })).parse(await db.all(sql`
    SELECT app_id, COUNT(*) AS calls, SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed FROM ${appCalls}
    WHERE started_at >= ${since} AND app_id IN (${sql.join(appIds.map((id) => sql`${id}`), sql`, `)}) GROUP BY app_id
  `))
  return new Map(rows.map((row) => [row.app_id, { calls: row.calls, failed: row.failed }]))
}

/** One run of a schedule, as its calendar reads it. */
export interface AppScheduleCallTime {
  schedule: string
  startedAt: number
  outcome: AppCallOutcome
}

/** The calls of an app's schedules from `from` to before `to`. */
export async function scheduleCallsBetween(appId: string, from: number, to: number, db: Db = getDatabase()): Promise<AppScheduleCallTime[]> {
  const rows = z.array(z.object({ caller: z.string(), started_at: timeSchema, outcome: z.enum(['running', 'ok', 'failed']) })).parse(await db.all(sql`
    SELECT caller, started_at, outcome FROM ${appCalls} WHERE app_id = ${appId} AND caller_kind = 'schedule' AND started_at >= ${from} AND started_at < ${to}
  `))
  return rows.flatMap((row) => {
    const caller = appCallerSchema.parse(JSON.parse(row.caller))
    return caller.kind === 'schedule' ? [{ schedule: caller.name, startedAt: row.started_at, outcome: row.outcome }] : []
  })
}

/** When the oldest call the log keeps of an app started, when the log is full and so lost older calls; else null. */
export async function callLogKeptSince(appId: string, db: Db = getDatabase()): Promise<number | null> {
  const row = z.object({ count: z.coerce.number(), oldest: nullableTimeSchema }).parse(await db.get(sql`
    SELECT COUNT(*) AS count, MIN(started_at) AS oldest FROM ${appCalls} WHERE app_id = ${appId}
  `))
  return row.count >= MAX_CALLS_PER_APP ? row.oldest : null
}

/** One call as the metrics read it: no input, no log line. */
export interface AppCallTiming {
  operation: string
  startedAt: number
  finishedAt: number | null
  outcome: AppCallOutcome
}

/** The calls of an app that pass the filter, as the numbers read them, the oldest first. */
export async function callTimings(appId: string, filter: AppCallFilter, db: Db = getDatabase()): Promise<AppCallTiming[]> {
  const rows = z.array(z.object({ operation: z.string(), started_at: timeSchema, finished_at: nullableTimeSchema, outcome: z.enum(['running', 'ok', 'failed']) })).parse(await db.all(sql`
    SELECT operation, started_at, finished_at, outcome FROM ${appCalls} WHERE ${callWhere(appId, filter)} ORDER BY started_at
  `))
  return rows.map((row) => ({ operation: row.operation, startedAt: row.started_at, finishedAt: row.finished_at, outcome: row.outcome }))
}

/** The calls of an app since a time, the oldest first. */
export async function callTimingsSince(appId: string, since: number, db: Db = getDatabase()): Promise<AppCallTiming[]> {
  const rows = z.array(z.object({ operation: z.string(), started_at: timeSchema, finished_at: nullableTimeSchema, outcome: z.enum(['running', 'ok', 'failed']) })).parse(await db.all(sql`
    SELECT operation, started_at, finished_at, outcome FROM ${appCalls} WHERE app_id = ${appId} AND started_at >= ${since} ORDER BY started_at
  `))
  return rows.map((row) => ({ operation: row.operation, startedAt: row.started_at, finishedAt: row.finished_at, outcome: row.outcome }))
}
