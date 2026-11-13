import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { appSignalActionSchema, appSignalDeliverySchema, type AppSignalAction, type AppSignalDelivery } from '@solus/contracts/apps'
import { getDatabase, type Db } from '../../db/database'
import { appSignalActions, appSignals } from './schema'
import type { StoredJson } from './app-workflow-store'

/**
 * The records of signals (docs/plans/apps.md §8.4): each occurrence with how
 * each signal action ended, and the signal actions the owner made.
 */

/** The occurrences an app keeps. */
export const MAX_OCCURRENCES_PER_APP = 1000

export interface AppOccurrenceRecord {
  id: string
  appId: string
  name: string
  payload: StoredJson
  emittedAt: number
  callId: string | null
  runId: string | null
  deliveries: AppSignalDelivery[]
}

export interface AppSignalActionRecord {
  id: string
  appId: string
  signal: string
  action: AppSignalAction
  enabled: boolean
  createdAt: number
}

const flagSchema = z.union([z.boolean(), z.number()]).transform((value) => value === true || value === 1)

function flag(db: Db, value: boolean): boolean | number {
  return db.engine === 'postgres' ? value : value ? 1 : 0
}

const occurrenceRowSchema = z.object({
  id: z.string(),
  app_id: z.string(),
  name: z.string(),
  payload: z.string(),
  emitted_at: z.coerce.number(),
  call_id: z.string().nullable(),
  run_id: z.string().nullable(),
  deliveries: z.string(),
})

function occurrenceFromRow(row: z.infer<typeof occurrenceRowSchema>): AppOccurrenceRecord {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    payload: z.json().parse(JSON.parse(row.payload)),
    emittedAt: row.emitted_at,
    callId: row.call_id,
    runId: row.run_id,
    deliveries: z.array(appSignalDeliverySchema).parse(JSON.parse(row.deliveries)),
  }
}

/** Keeps one occurrence. Answers false when its id is there already: a step that ran again emits the same ids. */
export async function insertOccurrence(record: AppOccurrenceRecord, db: Db = getDatabase()): Promise<boolean> {
  const written = await db.run(sql`
    INSERT INTO ${appSignals} (id, app_id, name, payload, emitted_at, call_id, run_id, deliveries)
    VALUES (${record.id}, ${record.appId}, ${record.name}, ${JSON.stringify(record.payload)}, ${record.emittedAt}, ${record.callId}, ${record.runId}, ${JSON.stringify(record.deliveries)})
    ON CONFLICT(id) DO NOTHING
  `)
  return written.changes > 0
}

export async function saveDeliveries(occurrenceId: string, deliveries: readonly AppSignalDelivery[], db: Db = getDatabase()): Promise<void> {
  await db.run(sql`UPDATE ${appSignals} SET deliveries = ${JSON.stringify(deliveries)} WHERE id = ${occurrenceId}`)
}

/** The newest occurrences of an app, of one signal when given. */
export async function listOccurrences(appId: string, limit: number, signal?: string, db: Db = getDatabase()): Promise<AppOccurrenceRecord[]> {
  const rows = await db.all(signal === undefined
    ? sql`SELECT * FROM ${appSignals} WHERE app_id = ${appId} ORDER BY emitted_at DESC, id DESC LIMIT ${limit}`
    : sql`SELECT * FROM ${appSignals} WHERE app_id = ${appId} AND name = ${signal} ORDER BY emitted_at DESC, id DESC LIMIT ${limit}`)
  return z.array(occurrenceRowSchema).parse(rows).map(occurrenceFromRow)
}

/** For each signal of an app: when it was last emitted, and how many times since a time. */
export async function occurrenceCounts(appId: string, since: number, db: Db = getDatabase()): Promise<Map<string, { lastEmittedAt: number; countSince: number }>> {
  const rows = z.array(z.object({ name: z.string(), last: z.coerce.number(), recent: z.coerce.number() })).parse(await db.all(sql`
    SELECT name, MAX(emitted_at) AS last, SUM(CASE WHEN emitted_at >= ${since} THEN 1 ELSE 0 END) AS recent FROM ${appSignals} WHERE app_id = ${appId} GROUP BY name
  `))
  return new Map(rows.map((row) => [row.name, { lastEmittedAt: row.last, countSince: row.recent }]))
}

export async function pruneOccurrences(appId: string, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    DELETE FROM ${appSignals} WHERE app_id = ${appId} AND id NOT IN (
      SELECT id FROM ${appSignals} WHERE app_id = ${appId} ORDER BY emitted_at DESC, id DESC LIMIT ${MAX_OCCURRENCES_PER_APP}
    )
  `)
}

const actionRowSchema = z.object({
  id: z.string(),
  app_id: z.string(),
  signal: z.string(),
  action: z.string(),
  enabled: flagSchema,
  created_at: z.coerce.number(),
})

function actionFromRow(row: z.infer<typeof actionRowSchema>): AppSignalActionRecord {
  return { id: row.id, appId: row.app_id, signal: row.signal, action: appSignalActionSchema.parse(JSON.parse(row.action)), enabled: row.enabled, createdAt: row.created_at }
}

/** The signal actions of an app, in the order they were made. */
export async function listSignalActions(appId: string, db: Db = getDatabase()): Promise<AppSignalActionRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${appSignalActions} WHERE app_id = ${appId} ORDER BY created_at, id`)
  return z.array(actionRowSchema).parse(rows).map(actionFromRow)
}

export async function loadSignalAction(appId: string, actionId: string, db: Db = getDatabase()): Promise<AppSignalActionRecord | null> {
  const row = await db.get(sql`SELECT * FROM ${appSignalActions} WHERE app_id = ${appId} AND id = ${actionId}`)
  return row ? actionFromRow(actionRowSchema.parse(row)) : null
}

export async function saveSignalAction(record: AppSignalActionRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${appSignalActions} (id, app_id, signal, action, enabled, created_at)
    VALUES (${record.id}, ${record.appId}, ${record.signal}, ${JSON.stringify(record.action)}, ${flag(db, record.enabled)}, ${record.createdAt})
    ON CONFLICT(id) DO UPDATE SET signal = excluded.signal, action = excluded.action, enabled = excluded.enabled
  `)
}

export async function deleteSignalAction(appId: string, actionId: string, db: Db = getDatabase()): Promise<boolean> {
  return (await db.run(sql`DELETE FROM ${appSignalActions} WHERE app_id = ${appId} AND id = ${actionId}`)).changes > 0
}

/** Deletes the signal actions of the signals an app no longer declares. */
export async function deleteSignalActionsExcept(appId: string, signals: readonly string[], db: Db = getDatabase()): Promise<void> {
  if (signals.length === 0) await db.run(sql`DELETE FROM ${appSignalActions} WHERE app_id = ${appId}`)
  else await db.run(sql`DELETE FROM ${appSignalActions} WHERE app_id = ${appId} AND signal NOT IN (${sql.join(signals.map((name) => sql`${name}`), sql`, `)})`)
}
