import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../db/database'
import { createLogger } from '../logger'
import { ulid } from './ulid'
import { appendTaskEvent } from './task-events'
import { taskComments, taskCounters, taskExternalLinks, tasks } from './schema'
import type {
  Task,
  TaskActor,
  TaskComment,
  TaskCreateInput,
  TaskListFilter,
  TaskListResult,
  TaskSource,
  TaskStatus,
  TaskTitleSource,
} from '@solus/contracts/task-types'

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
const taskSourceSchema = z.enum(['user', 'agent', 'automation', 'import', 'session'])
const taskPrioritySchema = z.enum(['urgent', 'high', 'medium', 'low'])
const taskRowSchema = z.object({
  id: z.string(),
  short_id: z.number().nullable(),
  project_key: z.string().nullable(),
  parent_id: z.string().nullable(),
  title: z.string(),
  title_source: z.enum(['prompt', 'generated', 'manual']),
  body: z.string(),
  status: taskStatusSchema,
  kind: z.enum(['task', 'epic']),
  assignee: z.string().nullable(),
  due_date: z.string().nullable(),
  priority: taskPrioritySchema.nullable(),
  labels: z.string(),
  pr: z.string().nullable(),
  source: taskSourceSchema,
  origin_session_id: z.string().nullable(),
  origin_automation_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  triaged_at: z.number().nullable(),
  done_at: z.number().nullable(),
  last_read_at: z.number().nullable(),
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
const labelListSchema = z.array(z.string())
const nextShortIdRowSchema = z.object({ next_id: z.number() })

export type TaskRow = z.infer<typeof taskRowSchema>
type TaskCommentRow = z.infer<typeof taskCommentRowSchema>

type TasksChangedListener = () => void
const changedListeners = new Set<TasksChangedListener>()

/** Subscribe to any native task mutation. The task store is global, so the
 * event deliberately carries no cwd/project payload. */
export function onTasksChanged(listener: TasksChangedListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

/** Broadcast a task mutation. Fired once per committed public write (the `Task`
 * object and the session-binding store own those). */
export function emitChanged(): void {
  for (const listener of changedListeners) {
    try {
      listener()
    } catch (error) {
      log.error('tasks_changed_listener_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
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
    projectKey: row.project_key,
    kind: row.kind,
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
  if (row.parent_id !== null) task.parentId = row.parent_id
  if (row.due_date !== null) task.dueDate = row.due_date
  if (row.priority !== null) task.priority = row.priority
  const pr = jsonValue(row.pr, taskPrSchema)
  if (pr) task.pr = pr
  if (row.origin_session_id !== null) task.originSessionId = row.origin_session_id
  if (row.origin_automation_id !== null) task.originAutomationId = row.origin_automation_id
  if (row.triaged_at !== null) task.triagedAt = row.triaged_at
  if (row.done_at !== null) task.doneAt = row.done_at
  if (row.last_read_at !== null) task.lastReadAt = row.last_read_at
  return task
}

function commentFromRow(row: TaskCommentRow): TaskComment {
  const comment: TaskComment = {
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    source: row.source,
    body: row.body,
    createdAt: row.created_at,
  }
  if (row.external_id !== null) comment.externalId = row.external_id
  if (row.origin_session_id !== null) comment.originSessionId = row.origin_session_id
  if (row.dirty === 1) comment.syncPending = true
  return comment
}

/** The tasks domain's database handle: SQLite on a host, Postgres in the cloud. */
export const database = getDatabase

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
 * Every read names the organization the caller works in
 * (docs/plans/cloud-service-model.md): a task of another organization is not
 * found, not refused. A task id is a ULID, so a child row keyed by a task id
 * this check has passed is already the organization's own.
 */
async function taskRow(organizationId: string, id: string, db: Db = database()): Promise<TaskRow | undefined> {
  return taskRowSchema.nullish().parse(await db.get(sql`
    ${TASK_SELECT} WHERE tasks.id = ${id} AND tasks.organization_id = ${organizationId}
  `)) ?? undefined
}

/** Internal record read used by the session-link store. */
export async function loadTaskRecord(organizationId: string, id: string): Promise<Task | null> {
  const row = await taskRow(organizationId, id)
  return row ? taskFromRow(row) : null
}

export async function listTaskChildren(organizationId: string, parentId: string): Promise<Task[]> {
  const rows = taskRowSchema.array().parse(await database().all(sql`
    ${TASK_SELECT}
    WHERE tasks.parent_id = ${parentId} AND tasks.organization_id = ${organizationId}
    ORDER BY tasks.updated_at DESC, tasks.created_at DESC, tasks.id
  `))
  return rows.map(taskFromRow)
}

export async function requireTask(organizationId: string, id: string, db: Db = database()): Promise<TaskRow> {
  const row = await taskRow(organizationId, id, db)
  if (!row) throw new Error(`Task ${id} not found.`)
  return row
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

export async function parentForChild(
  organizationId: string,
  parentId: string,
  childId: string | undefined,
  db: Db,
): Promise<TaskRow> {
  if (parentId === childId) throw new Error('A task cannot be its own parent.')
  const parent = await requireTask(organizationId, parentId, db)
  if (parent.parent_id !== null) throw new Error('Subtasks cannot contain nested subtasks.')
  if (childId) {
    const child = await requireTask(organizationId, childId, db)
    const nested = await db.get(sql`SELECT 1 AS present FROM ${tasks} WHERE parent_id = ${childId} LIMIT 1`)
    if (nested) throw new Error('A task with subtasks cannot itself become a subtask.')
    if (child.id === parent.id) throw new Error('A task cannot be its own parent.')
  }
  return parent
}

/** A task's origin, as the activity feed reads it. */
const ACTOR_BY_SOURCE = {
  user: 'user',
  agent: 'agent',
  session: 'agent',
  automation: 'automation',
  import: 'system',
} satisfies Record<TaskSource, TaskActor>

export async function writeTask(db: Db, organizationId: string, input: TaskCreateInput & {
  titleSource: TaskTitleSource
  status: TaskStatus
  source: TaskSource
  now: number
  /** A runner minted the id before the op left it (cloud-service-model.md §16); the row keeps it. */
  id?: string
}): Promise<Task> {
  assertTaskStatus(input.status)
  const title = input.title.trim()
  if (!title) throw new Error('Task title cannot be empty.')

  let projectKey = normalizedOptional(input.projectKey)
  const parentId = normalizedOptional(input.parentId)
  if (parentId) {
    const parent = await parentForChild(organizationId, parentId, undefined, db)
    if (projectKey !== null && projectKey !== parent.project_key) {
      throw new Error('A subtask must belong to the same project as its parent.')
    }
    projectKey = parent.project_key
  }

  const id = input.id ?? ulid(input.now)
  const triagedAt = input.status === 'inbox' ? null : input.now
  const doneAt = input.status === 'done' ? input.now : null
  await db.run(sql`
    INSERT INTO ${tasks}(
      id, short_id, project_key, parent_id, title, title_source, body, status,
      kind, assignee, due_date, priority, labels,
      source, origin_session_id, origin_automation_id, created_at, updated_at,
      triaged_at, done_at, organization_id
    ) VALUES (
      ${id}, ${await nextShortId(db)}, ${projectKey}, ${parentId}, ${title}, ${input.titleSource},
      ${input.body ?? ''}, ${input.status}, ${input.kind === 'epic' ? 'epic' : 'task'},
      ${normalizedOptional(input.assignee)}, ${normalizedOptional(input.dueDate)}, ${input.priority ?? null},
      ${JSON.stringify(input.labels ?? [])}, ${input.source}, ${normalizedOptional(input.originSessionId)},
      ${normalizedOptional(input.originAutomationId)}, ${input.now}, ${input.now}, ${triagedAt}, ${doneAt},
      ${organizationId}
    )
  `)
  await appendTaskEvent(db, organizationId, id, {
    kind: 'created',
    actor: ACTOR_BY_SOURCE[input.source] ?? 'user',
    to: input.status,
  }, input.now)
  return taskFromRow(await requireTask(organizationId, id, db))
}

export async function listTasks(organizationId: string, filter: TaskListFilter = {}): Promise<TaskListResult> {
  const clauses: SQL[] = [sql`tasks.organization_id = ${organizationId}`]
  const hasProjectKey = Object.prototype.hasOwnProperty.call(filter, 'projectKey')
  const hasParentId = Object.prototype.hasOwnProperty.call(filter, 'parentId')

  if (hasProjectKey) {
    if (filter.projectKey === null) clauses.push(sql`project_key IS NULL`)
    else clauses.push(sql`project_key = ${filter.projectKey ?? null}`)
  }
  if (hasParentId) {
    if (filter.parentId === null) clauses.push(sql`parent_id IS NULL`)
    else clauses.push(sql`parent_id = ${filter.parentId ?? null}`)
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

export async function commentsForTask(taskId: string, db: Db): Promise<TaskComment[]> {
  const rows = taskCommentRowSchema.array().parse(await db.all(sql`
    SELECT * FROM ${taskComments}
    WHERE task_id = ${taskId}
    ORDER BY created_at, id
  `))
  return rows.map(commentFromRow)
}

/** `origin` is the runner's own id and clock for a task it created before the op reached this database. */
export async function createTask(organizationId: string, input: TaskCreateInput, origin?: { id: string; now: number }): Promise<Task> {
  const task = await database().transaction((db) => {
    const projectKey = normalizedOptional(input.projectKey)
    const source = input.source ?? 'user'
    const status = input.status ?? (projectKey === null ? 'inbox' : 'todo')
    return writeTask(db, organizationId, {
      ...input,
      projectKey,
      source,
      status,
      titleSource: source === 'session' ? 'prompt' : 'manual',
      now: origin?.now ?? Date.now(),
      id: origin?.id,
    })
  })
  emitChanged()
  return task
}
