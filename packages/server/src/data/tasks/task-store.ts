import { afterDatabaseCommit } from '../../db/database'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../../db/database'
import { createLogger } from '../../logger'
import { ulid } from '@solus/contracts/ulid'
import { assertTaskAssignee, legacyTaskActor, notifyTaskAssignment, taskChanged } from './task-activity'
import { appendActivity } from '../activity/activity'
import { agentAttribution, hostAttribution, parseStoredAttribution } from '../stored-attribution'
import { taskComments, taskCounters, taskExternalLinks, tasks } from './schema'
import { scopeClause } from '../scope'
import type { RecordScope } from '../../admission/principal'
import type {
  Task,
  TaskComment,
  TaskCreateInput,
  TaskListFilter,
  TaskListResult,
  TaskSource,
  TaskStatus,
  TaskTitleSource,
} from '@solus/contracts/task-types'
import type { Attribution } from '@solus/contracts/user'

const log = createLogger('main', 'task-store')
const TASK_STATUSES = new Set<TaskStatus>([
  'inbox',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'dropped',
])

const taskStatusSchema = z.enum(['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped'])
const taskSourceSchema = z.enum(['user', 'agent', 'automation', 'import'])
const taskPrioritySchema = z.enum(['urgent', 'high', 'medium', 'low'])
const taskRowSchema = z.object({
  id: z.string(),
  short_id: z.number().nullable(),
  project_key: z.string().nullable(),
  title: z.string(),
  title_source: z.enum(['prompt', 'generated', 'manual']),
  body: z.string(),
  status: taskStatusSchema,
  assignee: z.string().nullable(),
  assignee_user_id: z.string().nullable(),
  due_date: z.string().nullable(),
  priority: taskPrioritySchema.nullable(),
  labels: z.string(),
  pr: z.string().nullable(),
  epic: z.string().nullable(),
  source: taskSourceSchema,
  origin_session_id: z.string().nullable(),
  origin_automation_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  triaged_at: z.number().nullable(),
  done_at: z.number().nullable(),
  last_read_at: z.number().nullable(),
  organization_id: z.string(),
  /** Joined from `task_external_links`; null on a task with no ticket. A link
   * written by a provider this build does not know reads as null, so one
   * unknown row cannot fail the whole task list. */
  external_provider: z.enum(['github', 'jira']).nullable().catch(null),
  external_id: z.string().nullable(),
  external_url: z.string().nullable(),
})
const taskCommentRowSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  author: z.string().nullable(),
  source: z.enum(['local', 'external']),
  external_id: z.string().nullable(),
  origin_session_id: z.string().nullable(),
  body: z.string(),
  created_at: z.number(),
  dirty: z.number(),
})
export const taskPrSchema = z.object({ url: z.string(), number: z.number() })
export const taskEpicSchema = z.object({
  provider: z.enum(['github', 'jira']),
  externalId: z.string(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
})
const labelListSchema = z.array(z.string())
const nextShortIdRowSchema = z.object({ next_id: z.number() })

export type TaskRow = z.infer<typeof taskRowSchema>
type TaskCommentRow = z.infer<typeof taskCommentRowSchema>

type TasksChangedListener = (taskId?: string) => void
const changedListeners = new Set<TasksChangedListener>()

/** Subscribe to any native task mutation. The task store is global, so the
 * event carries no cwd/project payload — only the one task that changed, when
 * the write touched exactly one. */
export function onTasksChanged(listener: TasksChangedListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

/** Broadcast a task mutation. Fired once per committed public write (the `Task`
 * object and the session-binding store own those). Name the task when the write
 * touched exactly one that still exists: clients then re-read that row alone.
 * A write across many tasks, or a delete, names none and clients re-read all. */
export function emitChanged(taskId?: string): void {
  void afterDatabaseCommit(async () => {
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

export function taskFromRow(row: TaskRow): Task {
  const task: Task = {
    id: row.id,
    providerId: 'local',
    organizationId: row.organization_id,
    projectKey: row.project_key,
    title: row.title,
    titleSource: row.title_source,
    body: row.body,
    status: row.status,
    url: null,
    labels: jsonValue(row.labels, labelListSchema) ?? [],
    canEditPlanningFields: true,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.short_id !== null) task.shortId = row.short_id
  if (row.external_provider && row.external_id) {
    task.mirroredTicket = {
      provider: row.external_provider,
      externalId: row.external_id,
      url: row.external_url ?? '',
    }
  }
  if (row.assignee !== null) task.assignee = row.assignee
  if (row.assignee_user_id !== null) task.assigneeUserId = row.assignee_user_id
  if (row.due_date !== null) task.dueDate = row.due_date
  if (row.priority !== null) task.priority = row.priority
  const pr = jsonValue(row.pr, taskPrSchema)
  if (pr) task.pr = pr
  const epic = jsonValue(row.epic, taskEpicSchema)
  if (epic) task.epic = epic
  if (row.origin_session_id !== null) task.originSessionId = row.origin_session_id
  if (row.origin_automation_id !== null) task.originAutomationId = row.origin_automation_id
  if (row.triaged_at !== null) task.triagedAt = row.triaged_at
  if (row.done_at !== null) task.doneAt = row.done_at
  if (row.last_read_at !== null) task.lastReadAt = row.last_read_at
  return task
}

/**
 * A local comment's author is a stored attribution; an older row holds a label
 * (`'You'`, `'agent'`), read as `legacyTaskActor` reads it. An upstream comment's
 * author is the other system's name for them.
 */
function commentFromRow(row: TaskCommentRow): TaskComment {
  const comment: TaskComment = {
    id: row.id,
    taskId: row.task_id,
    source: row.source,
    body: row.body,
    createdAt: row.created_at,
  }
  if (row.source === 'external') comment.externalAuthor = row.author
  else comment.author = parseStoredAttribution(row.author) ?? (row.author ? legacyTaskActor(row.author, row.origin_session_id) : hostAttribution())
  if (row.external_id !== null) comment.externalId = row.external_id
  if (row.origin_session_id !== null) comment.originSessionId = row.origin_session_id
  if (row.dirty === 1) comment.syncPending = true
  return comment
}

/** The tasks domain's database handle: SQLite on a host, Postgres in the cloud. */
export const database = getDatabase

export const taskLocationSchema = z.strictObject({ organizationId: z.string().min(1) })
export type TaskLocation = z.infer<typeof taskLocationSchema>

/** A task that Share moved to an organization (cloud-sharing.md §3a): this host
 *  has only its location. The code lets a client ask the task's new owner. */
export class TaskMovedError extends Error {
  readonly code = 'MOVED' as const

  constructor(readonly taskId: string, readonly location: TaskLocation) {
    super(`Task ${taskId} moved to organization ${location.organizationId}.`)
    this.name = 'TaskMovedError'
  }
}

/** The rows of tasks that are on this host. Every read of `tasks` that is not
 *  about a moved task's location carries it, as works carry `location IS NULL`. */
export const TASK_HERE = sql`tasks.location IS NULL`

/** Where a task Share moved is now, or null for a task on this host or no task. */
export async function taskLocation(scope: RecordScope, id: string, db: Db = database()): Promise<TaskLocation | null> {
  const row = z.object({ location: z.string().nullable() }).nullish().parse(await db.get(sql`
    SELECT location FROM ${tasks} WHERE id = ${id} AND ${scopeClause(scope, sql`tasks.organization_id`)}
  `))
  return row?.location ? taskLocationSchema.parse(JSON.parse(row.location)) : null
}

/**
 * Every task read joins its external link, so a published task names its
 * provider everywhere it is listed — not only on the detail page, which is the
 * one surface that separately reads the full sync state.
 */
const TASK_SELECT = sql`
  SELECT
    tasks.*,
    task_external_links.provider AS external_provider,
    task_external_links.external_id AS external_id,
    task_external_links.url AS external_url
  FROM ${tasks}
  LEFT JOIN ${taskExternalLinks} ON task_external_links.task_id = tasks.id
`

/**
 * Every read names the scope the caller may see (organization-scope §3): one
 * organization, or every one for the host reading its own disk. A task outside
 * the scope is not found, not refused. A task id is a ULID, so a child row keyed
 * by a task id this check has passed is already inside the scope, and its
 * `organization_id` is the task's own.
 */
async function taskRow(scope: RecordScope, id: string, db: Db = database()): Promise<TaskRow | undefined> {
  return taskRowSchema.nullish().parse(await db.get(sql`
    ${TASK_SELECT} WHERE tasks.id = ${id} AND ${scopeClause(scope, sql`tasks.organization_id`)} AND ${TASK_HERE}
  `)) ?? undefined
}

/** Internal record read used by the session-link store. */
/** A task's organization, or null when there is no such task: the one column the access policy reads on every call. */
export async function taskOrganizationId(id: string): Promise<string | null> {
  const row = z.object({ organization_id: z.string() }).nullish().parse(await database().get(sql`
    SELECT organization_id FROM ${tasks} WHERE id = ${id}
  `))
  return row?.organization_id ?? null
}

export async function loadTaskRecord(scope: RecordScope, id: string): Promise<Task | null> {
  const row = await taskRow(scope, id)
  return row ? taskFromRow(row) : null
}

/** API metadata pages never read task bodies. The caller supplies an admitted visibility predicate. */
export async function readTaskMetadataPage(where: SQL, limit: number): Promise<Task[]> {
  const columns = tasks.columnNames().map(name => name === 'body'
    ? sql`'' AS body`
    : sql`${sql.identifier('tasks')}.${sql.identifier(name)}`)
  const rows = taskRowSchema.array().parse(await database().all(sql`
    SELECT ${sql.join(columns, sql`, `)}, task_external_links.provider AS external_provider,
      task_external_links.external_id AS external_id, task_external_links.url AS external_url
    FROM ${tasks} LEFT JOIN ${taskExternalLinks} ON task_external_links.task_id = tasks.id
    WHERE ${where} ORDER BY tasks.created_at DESC, tasks.id DESC LIMIT ${limit}
  `))
  return rows.map(taskFromRow)
}

export async function requireTask(scope: RecordScope, id: string, db: Db = database()): Promise<TaskRow> {
  const row = await taskRow(scope, id, db)
  if (row) return row
  const location = await taskLocation(scope, id, db)
  if (location) throw new TaskMovedError(id, location)
  throw new Error(`Task ${id} not found.`)
}

/** One upsert on the counter row: atomic on both engines (see `taskCounters`).
 * `WHERE true` keeps SQLite from reading `ON CONFLICT` as part of the SELECT.
 * The counter is one for the whole database: `short_id` is unique across it,
 * so a short id names one task wherever it is read. */
async function nextShortId(db: Db): Promise<number> {
  const row = nextShortIdRowSchema.parse(await db.get(sql`
    INSERT INTO ${taskCounters}(name, value)
    SELECT 'short_id', COALESCE(MAX(short_id), 0) + 1 FROM ${tasks} WHERE true
    ON CONFLICT(name) DO UPDATE SET value = task_counters.value + 1
    RETURNING value AS next_id
  `))
  return row.next_id
}

export function normalizedOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  return value.trim() || null
}

export function assertTaskStatus(status: TaskStatus): void {
  if (!TASK_STATUSES.has(status)) throw new Error(`Invalid task status: ${status}`)
}

/** Who made a task, when the caller does not say: read from where it came from. */
function creatorBySource(input: TaskCreateInput & { source: TaskSource }): Attribution {
  switch (input.source) {
    case 'agent': return agentAttribution(normalizedOptional(input.originSessionId))
    case 'automation': return { kind: 'automation', automationId: normalizedOptional(input.originAutomationId) ?? '' }
    case 'import': return { kind: 'system' }
    case 'user': return hostAttribution()
  }
}

export async function writeTask(db: Db, organizationId: string, input: TaskCreateInput & {
  titleSource: TaskTitleSource
  status: TaskStatus
  source: TaskSource
  now: number
  /** A runner minted the id before the op left it (cloud-service-model.md §16); the row keeps it. */
  id?: string
  /** Who made it; read from `source` when absent. */
  by?: Attribution
}): Promise<Task> {
  assertTaskStatus(input.status)
  const title = input.title.trim()
  if (!title) throw new Error('Task title cannot be empty.')

  const projectKey = normalizedOptional(input.projectKey)
  assertTaskAssignee(organizationId, normalizedOptional(input.assigneeUserId))

  const id = input.id ?? ulid(input.now)
  const triagedAt = input.status === 'inbox' ? null : input.now
  const doneAt = input.status === 'done' ? input.now : null
  await db.run(sql`
    INSERT INTO ${tasks}(
      id, short_id, project_key, title, title_source, body, status,
      assignee, assignee_user_id, due_date, priority, labels,
      source, origin_session_id, origin_automation_id, created_at, updated_at,
      triaged_at, done_at, organization_id
    ) VALUES (
      ${id}, ${await nextShortId(db)}, ${projectKey}, ${title}, ${input.titleSource},
      ${input.body ?? ''}, ${input.status},
      ${normalizedOptional(input.assignee)}, ${normalizedOptional(input.assigneeUserId)}, ${normalizedOptional(input.dueDate)}, ${input.priority ?? null},
      ${JSON.stringify(input.labels ?? [])}, ${input.source}, ${normalizedOptional(input.originSessionId)},
      ${normalizedOptional(input.originAutomationId)}, ${input.now}, ${input.now}, ${triagedAt}, ${doneAt},
      ${organizationId}
    )
  `)
  const by = input.by ?? creatorBySource(input)
  await appendActivity(organizationId, taskChanged(id, by, 'created', { to: input.status }, input.now), db)
  await notifyTaskAssignment(db, organizationId, { id, title }, null, normalizedOptional(input.assigneeUserId), by, input.now)
  return taskFromRow(await requireTask(organizationId, id, db))
}

/** `taskIds` narrows the list to those tasks, for a sidebar that re-reads only what changed. */
export async function listTasks(
  scope: RecordScope,
  filter: TaskListFilter = {},
  taskIds?: readonly string[],
): Promise<TaskListResult> {
  const clauses: SQL[] = [scopeClause(scope, sql`tasks.organization_id`), TASK_HERE]
  if (taskIds) {
    if (!taskIds.length) return { tasks: [] }
    clauses.push(sql`tasks.id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})`)
  }
  const hasProjectKey = Object.prototype.hasOwnProperty.call(filter, 'projectKey')

  if (hasProjectKey) {
    if (filter.projectKey === null) clauses.push(sql`project_key IS NULL`)
    else clauses.push(sql`project_key = ${filter.projectKey ?? null}`)
  }

  const statuses = filter.status === undefined
    ? []
    : Array.isArray(filter.status) ? filter.status : [filter.status]
  if (statuses.length) {
    clauses.push(sql`status IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})`)
  }

  if (filter.scope === 'inbox') clauses.push(sql`project_key IS NULL AND status = 'inbox'`)
  if (filter.scope === 'project') clauses.push(sql`project_key IS NOT NULL`)
  if (filter.scope === 'up_next') clauses.push(sql`status IN ('todo', 'in_progress', 'in_review')`)

  const rows = taskRowSchema.array().parse(await database().all(sql`
    ${TASK_SELECT}
    WHERE ${sql.join(clauses, sql` AND `)}
    ORDER BY tasks.updated_at DESC, tasks.created_at DESC, tasks.id
  `))
  return { tasks: rows.map(taskFromRow) }
}

const unfinishedTaskRowSchema = z.object({ id: z.string(), project_key: z.string().nullable() })

/** The project of each task that is not finished, by task id: only the two columns a watcher of live work reads. */
export async function unfinishedTaskProjects(scope: RecordScope): Promise<Map<string, string | null>> {
  const rows = unfinishedTaskRowSchema.array().parse(await database().all(sql`
    SELECT id, project_key FROM ${tasks}
    WHERE ${scopeClause(scope)} AND ${TASK_HERE} AND status NOT IN ('done', 'dropped')
  `))
  return new Map(rows.map((row) => [row.id, row.project_key]))
}

export async function commentsForTask(taskId: string, db: Db): Promise<TaskComment[]> {
  const rows = taskCommentRowSchema.array().parse(await db.all(sql`
    SELECT * FROM ${taskComments}
    WHERE task_id = ${taskId}
    ORDER BY created_at, id
  `))
  return rows.map(commentFromRow)
}

/** `origin` is the runner's own id and clock for a task it created before the op reached this database. */
export async function createTask(organizationId: string, input: TaskCreateInput, origin?: { id: string; now: number }, by?: Attribution): Promise<Task> {
  const task = await database().transaction((db) => {
    const projectKey = normalizedOptional(input.projectKey)
    const source = input.source ?? 'user'
    const status = input.status ?? (projectKey === null ? 'inbox' : 'todo')
    return writeTask(db, organizationId, {
      ...input,
      projectKey,
      source,
      status,
      titleSource: 'manual',
      now: origin?.now ?? Date.now(),
      id: origin?.id,
      by,
    })
  })
  emitChanged(task.id)
  return task
}
