import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { taskSourceSchema, type TaskSource } from '@solus/contracts/task-sources'
import type { TaskColumn, TaskSourceHealth } from '@solus/contracts/task-types'
import type { Db } from '../../db/database'
import { taskSourceAccess, taskSourceItems, taskSources } from './schema'
import { database, jsonValue, taskColumnsSchema } from './task-store'
import type { SourceWriteState } from './providers/types'

/**
 * The rows of the task sources: what a provider last answered for a source
 * (`task_sources`), where the source puts each task (`task_source_items`), and
 * which person's own connection read it (`task_source_access`).
 */

const writeStateSchema: z.ZodType<SourceWriteState> = z.union([
  z.object({ kind: z.literal('github-project'), projectId: z.string(), statusFieldId: z.string().nullable() }),
  z.object({
    kind: z.literal('jira-board'),
    projectKey: z.string().nullable(),
    columns: z.array(z.object({ columnId: z.string(), statusIds: z.array(z.string()) })),
  }),
])

const sourceRowSchema = z.object({
  source_key: z.string(),
  source: z.string(),
  label: z.string(),
  columns: z.string(),
  write_state: z.string().nullable(),
  fetched_at: z.coerce.number().nullable(),
  truncated: z.number(),
})

/** One source as the host holds it. */
export interface StoredTaskSource {
  sourceKey: string
  source: TaskSource
  label: string
  columns: TaskColumn[]
  writeState: SourceWriteState | null
  /** Null = no provider answered a read yet. */
  fetchedAt: number | null
  truncated: boolean
}

function sourceFromRow(row: z.infer<typeof sourceRowSchema>): StoredTaskSource | null {
  const source = jsonValue(row.source, taskSourceSchema)
  if (!source) return null
  return {
    sourceKey: row.source_key,
    source,
    label: row.label,
    columns: jsonValue(row.columns, taskColumnsSchema) ?? [],
    writeState: jsonValue(row.write_state, writeStateSchema) ?? null,
    fetchedAt: row.fetched_at,
    truncated: row.truncated === 1,
  }
}

export async function loadTaskSource(sourceKey: string, db: Db = database()): Promise<StoredTaskSource | null> {
  const row = sourceRowSchema.nullish().parse(await db.get(sql`SELECT * FROM ${taskSources} WHERE source_key = ${sourceKey}`))
  return row ? sourceFromRow(row) : null
}

export async function loadTaskSources(sourceKeys: readonly string[], db: Db = database()): Promise<Map<string, StoredTaskSource>> {
  const sources = new Map<string, StoredTaskSource>()
  if (!sourceKeys.length) return sources
  const rows = sourceRowSchema.array().parse(await db.all(sql`
    SELECT * FROM ${taskSources} WHERE source_key IN (${sql.join(sourceKeys.map((key) => sql`${key}`), sql`, `)})
  `))
  for (const row of rows) {
    const source = sourceFromRow(row)
    if (source) sources.set(source.sourceKey, source)
  }
  return sources
}

/** The source as a person reads it before a provider gave its own name. */
export function taskSourceLabel(source: TaskSource): string {
  switch (source.kind) {
    case 'github-repo': return `${source.owner}/${source.repo}`
    case 'github-project': return `${source.owner} #${source.number}`
    case 'jira-project': return source.projectKey
    case 'jira-board': return `Board ${source.boardId}`
  }
}

/** Make the row of a source that a person wants. A row that exists stays as it is. */
export async function ensureTaskSource(sourceKey: string, source: TaskSource, db: Db = database()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${taskSources}(source_key, source, label) VALUES (${sourceKey}, ${JSON.stringify(source)}, ${taskSourceLabel(source)})
    ON CONFLICT(source_key) DO NOTHING
  `)
}

const itemRowSchema = z.object({
  source_key: z.string(),
  task_id: z.string(),
  column_id: z.string().nullable(),
  item_id: z.string().nullable(),
})

export interface StoredSourceItem {
  sourceKey: string
  taskId: string
  columnId: string | null
  itemId: string | null
}

function itemFromRow(row: z.infer<typeof itemRowSchema>): StoredSourceItem {
  return { sourceKey: row.source_key, taskId: row.task_id, columnId: row.column_id, itemId: row.item_id }
}

/** Where each source that lists a task puts it. */
export async function sourceItemsOfTask(taskId: string, db: Db = database()): Promise<StoredSourceItem[]> {
  const rows = itemRowSchema.array().parse(await db.all(sql`
    SELECT source_key, task_id, column_id, item_id FROM ${taskSourceItems} WHERE task_id = ${taskId} ORDER BY source_key
  `))
  return rows.map(itemFromRow)
}

export async function sourceItemsOf(sourceKey: string, db: Db = database()): Promise<StoredSourceItem[]> {
  const rows = itemRowSchema.array().parse(await db.all(sql`
    SELECT source_key, task_id, column_id, item_id FROM ${taskSourceItems} WHERE source_key = ${sourceKey} ORDER BY position, task_id
  `))
  return rows.map(itemFromRow)
}

const accessRowSchema = z.object({
  source_key: z.string(),
  checked_at: z.coerce.number().nullable(),
  health: z.enum(['ok', 'not_connected', 'reconnect', 'no_access', 'error']),
  message: z.string().nullable(),
})

/** What one person's own connection last got from a source. */
export interface TaskSourceAccess {
  /** Null = this person's connection never read the source. */
  checkedAt: number | null
  health: TaskSourceHealth
  message: string | null
}

export async function loadTaskSourceAccess(personKey: string, sourceKeys: readonly string[], db: Db = database()): Promise<Map<string, TaskSourceAccess>> {
  const access = new Map<string, TaskSourceAccess>()
  if (!sourceKeys.length) return access
  const rows = accessRowSchema.array().parse(await db.all(sql`
    SELECT source_key, checked_at, health, message FROM ${taskSourceAccess}
    WHERE user_id = ${personKey} AND source_key IN (${sql.join(sourceKeys.map((key) => sql`${key}`), sql`, `)})
  `))
  for (const row of rows) access.set(row.source_key, { checkedAt: row.checked_at, health: row.health, message: row.message })
  return access
}

/**
 * Record the result of one person's read of a source. A read that the
 * provider answered sets `checkedAt`: the person now sees the tasks of the
 * source. A failed read keeps the `checked_at` the person had.
 */
export async function recordTaskSourceAccess(
  personKey: string,
  sourceKey: string,
  result: { checkedAt: number } | { health: Exclude<TaskSourceHealth, 'ok'>; message: string },
  db: Db = database(),
): Promise<void> {
  const checkedAt = 'checkedAt' in result ? result.checkedAt : null
  const health = 'health' in result ? result.health : 'ok'
  const message = 'message' in result ? result.message : null
  await db.run(sql`
    INSERT INTO ${taskSourceAccess}(user_id, source_key, checked_at, health, message)
    VALUES (${personKey}, ${sourceKey}, ${checkedAt}, ${health}, ${message})
    ON CONFLICT(user_id, source_key) DO UPDATE SET
      checked_at = COALESCE(excluded.checked_at, task_source_access.checked_at), health = excluded.health, message = excluded.message
  `)
}
