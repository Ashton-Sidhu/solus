import { afterDatabaseCommit } from '../../db/database'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../../db/database'
import { createLogger } from '../../logger'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { parseTaskKey, taskKey } from '@solus/contracts/task-sources'
import { taskSourceAccess, taskSourceItems, taskSources, tasks } from './schema'
import { commentThreads } from '../comments/schema'
import { personalResourceState } from '../personal-state/schema'
import { resourceLinks } from '../links/schema'
import { scopeClause } from '../scope'
import { recordTaskChange } from './task-revisions'
import { taskCategory } from './status-category'
import type { RecordScope } from '../../admission/principal'
import type { ProviderTask, TaskHome } from './providers/types'
import type { Task, TaskColumn, TaskPlacement, TaskSummary } from '@solus/contracts/task-types'

/**
 * The task cache: the host's copy of the tasks that GitHub and Jira own
 * (docs/plans/provider-owned-tasks.md §4.4). Only a provider answer writes a
 * row here; nothing writes a change that the provider did not take. A row has
 * no organization and no owner.
 */

const log = createLogger('main', 'task-store')

const categorySchema = z.enum(['open', 'active', 'done'])
const prioritySchema = z.enum(['urgent', 'high', 'medium', 'low'])
const fieldSchema = z.enum(['title', 'body', 'labels', 'assignee', 'priority', 'dueDate'])
export const taskEpicSchema = z.object({
  provider: z.enum(['github', 'jira']),
  externalId: z.string(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
})
export const taskHomeSchema: z.ZodType<TaskHome> = z.union([
  z.object({ provider: z.literal('github'), kind: z.literal('issue'), owner: z.string(), repo: z.string(), number: z.number() }),
  z.object({ provider: z.literal('github'), kind: z.literal('draft'), projectId: z.string(), itemId: z.string() }),
  z.object({ provider: z.literal('jira'), cloudId: z.string(), key: z.string() }),
])
export const taskColumnsSchema: z.ZodType<TaskColumn[]> = z.array(z.object({ id: z.string(), name: z.string(), category: categorySchema }))

const taskRowSchema = z.object({
  id: z.string(),
  provider: z.enum(['github', 'jira']),
  kind: z.enum(['issue', 'draft']),
  reference: z.string().nullable(),
  url: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  state_name: z.string(),
  state_category: categorySchema,
  state_id: z.string().nullable(),
  category: categorySchema,
  assignee: z.string().nullable(),
  assignee_avatar_url: z.string().nullable(),
  labels: z.string(),
  priority: prioritySchema.nullable(),
  due_date: z.string().nullable(),
  epic: z.string().nullable(),
  writable_fields: z.string(),
  home: z.string(),
  created_at: z.coerce.number().nullable(),
  updated_at: z.coerce.number(),
  last_read_at: z.coerce.number().nullable(),
  /** The URL of the task's newest pull request link (`TASK_PR_URL`); null with none. */
  pr_url: z.string().nullable(),
})
/** A task row without its body and epic: what a list reads. */
const taskSummaryRowSchema = taskRowSchema.omit({ body: true, epic: true })

export type TaskRow = z.infer<typeof taskRowSchema>
type TaskSummaryRow = z.infer<typeof taskSummaryRowSchema>

type TasksChangedListener = (taskId?: string) => void
const changedListeners = new Set<TasksChangedListener>()

/** Hear each change of a task's copy or attachments. The event names the one
 *  task that changed, when the write touched exactly one. */
export function onTasksChanged(listener: TasksChangedListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

/** Broadcast a task change, after the commit. Name the task when the write
 * touched exactly one that still exists: clients then read that row alone.
 * A write across many tasks, or a delete, names none and clients read all. */
export function emitChanged(taskId?: string): void {
  void afterDatabaseCommit(async () => {
    recordTaskChange(taskId)
    for (const listener of changedListeners) {
      try {
        listener(taskId)
      } catch (error) {
        log.error('tasks_changed_listener_failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })
}

export function jsonValue<T>(value: string | null, schema: z.ZodType<T>): T | undefined {
  if (value === null) return undefined
  try {
    return schema.parse(JSON.parse(value))
  } catch {
    return undefined
  }
}

/** The tasks domain's database handle: SQLite on a host, Postgres in the cloud. */
export const database = getDatabase

export function normalizedOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  return value.trim() || null
}

/** Refuse an id that is not a task key, such as an id from before tasks were
 *  provider-owned. An attachment needs no row in `tasks`, only a real key. */
export function assertTaskKey(taskId: string): void {
  if (!parseTaskKey(taskId)) throw new Error(`"${taskId}" is not a task of GitHub or Jira.`)
}

function taskSummaryFromRow(row: TaskSummaryRow, placements: TaskPlacement[]): TaskSummary {
  const task: TaskSummary = {
    id: row.id,
    providerId: row.provider,
    kind: row.kind,
    title: row.title,
    url: row.url,
    state: { name: row.state_name, category: row.state_category },
    category: row.category,
    placements,
    labels: jsonValue(row.labels, z.array(z.string())) ?? [],
    writableFields: jsonValue(row.writable_fields, z.array(fieldSchema)) ?? [],
    updatedAt: row.updated_at,
  }
  if (row.reference !== null) task.reference = row.reference
  if (row.assignee !== null) task.assignee = row.assignee
  if (row.assignee_avatar_url !== null) task.assigneeAvatarUrl = row.assignee_avatar_url
  if (row.due_date !== null) task.dueDate = row.due_date
  if (row.priority !== null) task.priority = row.priority
  if (row.pr_url !== null) task.pr = { url: row.pr_url, number: parseGitHubPullRequestUrl(row.pr_url)?.number ?? 0 }
  if (row.created_at !== null) task.createdAt = row.created_at
  if (row.last_read_at !== null) task.lastReadAt = row.last_read_at
  return task
}

function taskFromRow(row: TaskRow, placements: TaskPlacement[]): Task {
  const task: Task = { ...taskSummaryFromRow(row, placements), body: row.body }
  const epic = jsonValue(row.epic, taskEpicSchema)
  if (epic) task.epic = epic
  return task
}

/** The task's compact pull request (`Task.pr`): the URL of its newest own pull request link, one index seek per row. */
const TASK_PR_URL = sql`(SELECT resource_links.url FROM ${resourceLinks}
    WHERE resource_links.source_kind = 'task' AND resource_links.source_id = tasks.id AND resource_links.target_kind = 'pr' AND resource_links.url IS NOT NULL
    ORDER BY resource_links.created_at DESC LIMIT 1) AS pr_url`

function columnsOf(names: readonly string[]): SQL {
  return sql.join(names.map((name) => sql`${sql.identifier('tasks')}.${sql.identifier(name)}`), sql`, `)
}
const TASK_COLUMNS = taskRowSchema.keyof().options.filter((name) => name !== 'pr_url')
const TASK_SELECT = sql`SELECT ${columnsOf(TASK_COLUMNS)}, ${TASK_PR_URL} FROM ${tasks}`
/** A list never shows a body or an epic, so the list statement selects neither. */
const TASK_SUMMARY_SELECT = sql`SELECT ${columnsOf(TASK_COLUMNS.filter((name) => name !== 'body' && name !== 'epic'))}, ${TASK_PR_URL} FROM ${tasks}`

const placementRowSchema = z.object({ task_id: z.string(), source_key: z.string(), column_id: z.string().nullable() })

/** Where each task is in the sources that list it. `personKey` keeps only the
 *  sources that person's own connection read. */
async function placementsOf(db: Db, taskIds: readonly string[], personKey?: string): Promise<Map<string, TaskPlacement[]>> {
  const placements = new Map<string, TaskPlacement[]>()
  if (!taskIds.length) return placements
  const readByPerson = personKey === undefined
    ? sql``
    : sql` AND EXISTS (SELECT 1 FROM ${taskSourceAccess} WHERE task_source_access.source_key = task_source_items.source_key
        AND task_source_access.user_id = ${personKey} AND task_source_access.checked_at IS NOT NULL)`
  const rows = placementRowSchema.array().parse(await db.all(sql`
    SELECT task_id, source_key, column_id FROM ${taskSourceItems}
    WHERE task_id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})${readByPerson}
    ORDER BY source_key
  `))
  for (const row of rows) {
    const placement = { sourceKey: row.source_key, columnId: row.column_id }
    const held = placements.get(row.task_id)
    if (held) held.push(placement)
    else placements.set(row.task_id, [placement])
  }
  return placements
}

/** The host's copy of a task, or null when the host never read it. */
export async function loadTask(id: string, db: Db = database()): Promise<Task | null> {
  const row = taskRowSchema.nullish().parse(await db.get(sql`${TASK_SELECT} WHERE tasks.id = ${id}`))
  if (!row) return null
  return taskFromRow(row, (await placementsOf(db, [id])).get(id) ?? [])
}

/** What the adapter needs to write to a task, from its copy. */
export async function taskHomeOf(id: string, db: Db = database()): Promise<TaskHome | null> {
  const row = z.object({ home: z.string() }).nullish().parse(await db.get(sql`SELECT home FROM ${tasks} WHERE id = ${id}`))
  return row ? jsonValue(row.home, taskHomeSchema) ?? null : null
}

export interface TaskReader {
  /** The person whose connections decide which sources show. */
  personKey: string
  /** The record scope of the reader, for the session links that show a task. */
  scope: RecordScope
}

/** A task a session of the reader's scope is linked to shows to the reader. */
function linkedToSession(scope: RecordScope): SQL {
  return sql`EXISTS (SELECT 1 FROM ${resourceLinks} WHERE resource_links.source_kind = 'task' AND resource_links.source_id = tasks.id
    AND resource_links.target_kind = 'session' AND resource_links.status = 'active' AND ${scopeClause(scope, sql`resource_links.organization_id`)})`
}

/**
 * The tasks a reader sees: the tasks of each source that the reader's own
 * connection read, and each task that a session of the reader's scope is linked
 * to. Two people on one host with different provider access do not see each
 * other's tasks. `taskIds` narrows the list to those tasks.
 */
export async function listTasks(reader: TaskReader, taskIds?: readonly string[]): Promise<TaskSummary[]> {
  if (taskIds && !taskIds.length) return []
  const db = database()
  const named = taskIds
    ? sql`tasks.id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)}) AND `
    : sql``
  const rows = taskSummaryRowSchema.array().parse(await db.all(sql`
    ${TASK_SUMMARY_SELECT}
    WHERE ${named}(
      EXISTS (SELECT 1 FROM ${taskSourceItems} JOIN ${taskSourceAccess} ON task_source_access.source_key = task_source_items.source_key
        WHERE task_source_items.task_id = tasks.id AND task_source_access.user_id = ${reader.personKey} AND task_source_access.checked_at IS NOT NULL)
      OR ${linkedToSession(reader.scope)}
    )
    ORDER BY tasks.updated_at DESC, tasks.id
  `))
  const placements = await placementsOf(db, rows.map((row) => row.id), reader.personKey)
  return rows.map((row) => taskSummaryFromRow(row, placements.get(row.id) ?? []))
}

/** The copies of the named tasks, whoever read them: for a caller that holds the keys already. */
export async function loadTaskSummaries(taskIds: readonly string[]): Promise<TaskSummary[]> {
  if (!taskIds.length) return []
  const db = database()
  const rows = taskSummaryRowSchema.array().parse(await db.all(sql`
    ${TASK_SUMMARY_SELECT} WHERE tasks.id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})
  `))
  const placements = await placementsOf(db, rows.map((row) => row.id))
  return rows.map((row) => taskSummaryFromRow(row, placements.get(row.id) ?? []))
}

/** One change of a task's `category`, which decides whether its sessions settle. */
export interface TaskCategoryChange {
  taskId: string
  from: Task['category'] | null
  to: Task['category']
}

/** What one write of a provider answer did to the host's copy. */
export interface TaskUpsert {
  /** A field that a list shows changed, or the task is new on this host. */
  changed: boolean
  /** The assignee the copy had. Undefined when the host had no copy. */
  previousAssignee: string | null | undefined
}

const storedFactsRowSchema = z.object({
  epic: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  state_name: z.string(),
  state_category: z.string(),
  assignee: z.string().nullable(),
  labels: z.string(),
  priority: z.string().nullable(),
  due_date: z.string().nullable(),
  reference: z.string().nullable(),
  updated_at: z.coerce.number(),
})

/**
 * Write one provider answer over the host's copy. Inside the caller's
 * transaction. A list read gives an epic with no description, so the
 * description of the same epic from an earlier detail read stays. Answers
 * whether a field a list shows changed, and the assignee the copy had.
 * `category` is not written here: `refreshTaskCategories` owns it, because it
 * needs the task's columns.
 */
export async function upsertProviderTask(db: Db, task: ProviderTask, now: number): Promise<TaskUpsert> {
  const id = taskKey(task.ref)
  const existing = storedFactsRowSchema.nullish().parse(await db.get(sql`
    SELECT epic, title, body, state_name, state_category, assignee, labels, priority, due_date, reference, updated_at
    FROM ${tasks} WHERE id = ${id}
  `))
  let epic = task.epic ?? null
  const heldEpic = existing ? jsonValue(existing.epic, taskEpicSchema) : undefined
  if (epic && !epic.body && heldEpic?.externalId === epic.externalId) epic = { ...epic, body: heldEpic.body }
  const labels = JSON.stringify(task.labels)
  await db.run(sql`
    INSERT INTO ${tasks}(
      id, provider, kind, reference, url, title, body, state_name, state_category, state_id, category,
      assignee, assignee_avatar_url, labels, priority, due_date, epic, writable_fields, home,
      created_at, updated_at, fetched_at
    ) VALUES (
      ${id}, ${task.ref.provider}, ${task.kind}, ${task.reference ?? null}, ${task.url}, ${task.title}, ${task.body},
      ${task.state.name}, ${task.state.category}, ${task.stateId ?? null}, ${taskCategory(task.state.category, [])},
      ${task.assignee ?? null}, ${task.assigneeAvatarUrl ?? null}, ${labels}, ${task.priority ?? null}, ${task.dueDate ?? null},
      ${epic ? JSON.stringify(epic) : null}, ${JSON.stringify(task.writableFields)}, ${JSON.stringify(task.home)},
      ${task.createdAt ?? null}, ${task.updatedAt}, ${now}
    )
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, reference = excluded.reference, url = excluded.url, title = excluded.title, body = excluded.body,
      state_name = excluded.state_name, state_category = excluded.state_category, state_id = excluded.state_id,
      assignee = excluded.assignee, assignee_avatar_url = excluded.assignee_avatar_url, labels = excluded.labels,
      priority = excluded.priority, due_date = excluded.due_date, epic = excluded.epic,
      writable_fields = excluded.writable_fields, home = excluded.home,
      created_at = COALESCE(excluded.created_at, tasks.created_at), updated_at = excluded.updated_at, fetched_at = excluded.fetched_at
  `)
  if (!existing) return { changed: true, previousAssignee: undefined }
  const changed = listFactsOf(existing) !== JSON.stringify([
    task.title, task.body, task.state.name, task.state.category, task.assignee ?? null, labels,
    task.priority ?? null, task.dueDate ?? null, task.reference ?? null, task.updatedAt,
  ])
  return { changed, previousAssignee: existing.assignee }
}

/** The facts of a stored task that a list or a page shows, as one comparable text. */
function listFactsOf(stored: z.infer<typeof storedFactsRowSchema>): string {
  return JSON.stringify([
    stored.title, stored.body, stored.state_name, stored.state_category, stored.assignee, stored.labels,
    stored.priority, stored.due_date, stored.reference, stored.updated_at,
  ])
}

const categoryFactsRowSchema = z.object({ id: z.string(), state_category: categorySchema, category: categorySchema })
const itemColumnRowSchema = z.object({ task_id: z.string(), column_id: z.string().nullable(), columns: z.string() })

/**
 * Set `Task.category` of the named tasks from their state and their columns
 * (`taskCategory`). Inside the caller's transaction, after the task rows and
 * the source items are written. Answers each task whose category changed.
 * `created` names the tasks that had no copy before this write.
 */
export async function refreshTaskCategories(db: Db, taskIds: readonly string[], created: ReadonlySet<string> = new Set()): Promise<TaskCategoryChange[]> {
  const ids = [...new Set(taskIds)]
  if (!ids.length) return []
  const named = sql.join(ids.map((taskId) => sql`${taskId}`), sql`, `)
  const facts = categoryFactsRowSchema.array().parse(await db.all(sql`
    SELECT id, state_category, category FROM ${tasks} WHERE id IN (${named})
  `))
  const items = itemColumnRowSchema.array().parse(await db.all(sql`
    SELECT task_source_items.task_id, task_source_items.column_id, task_sources.columns
    FROM ${taskSourceItems} JOIN ${taskSources} ON task_sources.source_key = task_source_items.source_key
    WHERE task_source_items.task_id IN (${named}) AND task_source_items.column_id IS NOT NULL
  `))
  const columnCategories = new Map<string, Task['category'][]>()
  for (const item of items) {
    const column = (jsonValue(item.columns, taskColumnsSchema) ?? []).find((candidate) => candidate.id === item.column_id)
    if (!column) continue
    const held = columnCategories.get(item.task_id)
    if (held) held.push(column.category)
    else columnCategories.set(item.task_id, [column.category])
  }
  const changes: TaskCategoryChange[] = []
  for (const fact of facts) {
    const category = taskCategory(fact.state_category, columnCategories.get(fact.id) ?? [])
    const isNew = created.has(fact.id)
    if (category === fact.category && !isNew) continue
    if (category !== fact.category) await db.run(sql`UPDATE ${tasks} SET category = ${category} WHERE id = ${fact.id}`)
    changes.push({ taskId: fact.id, from: isNew ? null : fact.category, to: category })
  }
  return changes
}

/** The ids of the named tasks that have a copy on this host. */
export async function storedTaskIds(db: Db, taskIds: readonly string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set()
  const rows = z.object({ id: z.string() }).array().parse(await db.all(sql`
    SELECT id FROM ${tasks} WHERE id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})
  `))
  return new Set(rows.map((row) => row.id))
}

/** The named tasks whose copy on this host is `done`. A task with no copy is not known to be done. */
export async function finishedTaskIds(taskIds: readonly string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set()
  const rows = z.object({ id: z.string() }).array().parse(await database().all(sql`
    SELECT id FROM ${tasks} WHERE category = 'done' AND id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})
  `))
  return new Set(rows.map((row) => row.id))
}

/** A copy that nothing holds and that no provider answer wrote for this long is deleted. */
export const UNHELD_TASK_MAX_AGE_MS = 24 * 60 * 60_000
/** The most copies one prune deletes, so a source read never waits on a large delete. */
const PRUNE_LIMIT = 500

/**
 * Delete the copies of tasks that nothing holds any more: a task that is in no
 * source, and has no attachment (no link, no session, no snooze) and no unsent
 * comment. Two kinds of copy are checked: each task of `leftSource`, which a
 * source read just took out of its source, and each copy that no provider
 * answer wrote since `staleBefore`, such as a task that only a search found.
 * Inside the transaction of a source read. Answers the tasks it deleted. The
 * provider still has the task; a later read or search makes a new copy.
 */
export async function pruneUnheldTasks(db: Db, leftSource: readonly string[], staleBefore: number): Promise<string[]> {
  const stale = sql`tasks.fetched_at < ${staleBefore}`
  const candidates = leftSource.length
    ? sql`(tasks.id IN (${sql.join(leftSource.map((taskId) => sql`${taskId}`), sql`, `)}) OR ${stale})`
    : stale
  const rows = z.object({ id: z.string() }).array().parse(await db.all(sql`
    SELECT tasks.id FROM ${tasks}
    WHERE ${candidates}
      AND NOT EXISTS (SELECT 1 FROM ${taskSourceItems} WHERE task_source_items.task_id = tasks.id)
      AND NOT EXISTS (SELECT 1 FROM ${resourceLinks} WHERE resource_links.source_kind = 'task' AND resource_links.source_id = tasks.id)
      AND NOT EXISTS (SELECT 1 FROM ${personalResourceState} WHERE personal_resource_state.resource_kind = 'task' AND personal_resource_state.resource_id = tasks.id)
      AND NOT EXISTS (SELECT 1 FROM ${commentThreads} WHERE comment_threads.subject_kind = 'task' AND comment_threads.subject_id = tasks.id
        AND comment_threads.delivery_state = 'pending')
    LIMIT ${PRUNE_LIMIT}
  `))
  const pruned = rows.map((row) => row.id)
  if (!pruned.length) return []
  const named = sql.join(pruned.map((taskId) => sql`${taskId}`), sql`, `)
  // The copies of the provider's comments go with the copy of the task.
  await db.run(sql`DELETE FROM ${commentThreads} WHERE subject_kind = 'task' AND subject_id IN (${named})`)
  await db.run(sql`DELETE FROM ${tasks} WHERE id IN (${named})`)
  return pruned
}
