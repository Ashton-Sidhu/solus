import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { getDb, withTx } from '../db'
import { createLogger } from '../logger'
import { ulid } from './ulid'
import { appendTaskEvent } from './task-events'
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

type TaskRow = z.infer<typeof taskRowSchema>
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

export const database = getDb

/**
 * Every task read joins its external link, so a published task names its
 * provider everywhere it is listed — not only on the detail page, which is the
 * one surface that separately reads the full sync state.
 */
const TASK_SELECT = `
  SELECT
    tasks.*,
    task_external_links.provider AS external_provider,
    task_external_links.external_id AS external_id,
    task_external_links.url AS external_url
  FROM tasks
  LEFT JOIN task_external_links ON task_external_links.task_id = tasks.id
`

function taskRow(id: string, db: DatabaseSync = database()): TaskRow | undefined {
  return taskRowSchema.nullish().parse(db.prepare(`${TASK_SELECT} WHERE tasks.id = ?`).get(id)) ?? undefined
}

/** Internal record read used by the session-link store. */
export function loadTaskRecord(id: string): Task | null {
  const row = taskRow(id)
  return row ? taskFromRow(row) : null
}

export function listTaskChildren(parentId: string): Task[] {
  const rows = taskRowSchema.array().parse(database().prepare(`
    ${TASK_SELECT}
    WHERE tasks.parent_id = ?
    ORDER BY tasks.updated_at DESC, tasks.created_at DESC, tasks.id
  `).all(parentId))
  return rows.map(taskFromRow)
}

export function requireTask(id: string, db: DatabaseSync = database()): TaskRow {
  const row = taskRow(id, db)
  if (!row) throw new Error(`Task ${id} not found.`)
  return row
}

function nextShortId(db: DatabaseSync): number {
  const row = nextShortIdRowSchema.parse(
    db.prepare('SELECT COALESCE(MAX(short_id), 0) + 1 AS next_id FROM tasks').get(),
  )
  return row.next_id
}

export function normalizedOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  return value.trim() || null
}

export function assertTaskStatus(status: TaskStatus): void {
  if (!TASK_STATUSES.has(status)) throw new Error(`Invalid task status: ${status}`)
}

export function parentForChild(parentId: string, childId: string | undefined, db: DatabaseSync): TaskRow {
  if (parentId === childId) throw new Error('A task cannot be its own parent.')
  const parent = requireTask(parentId, db)
  if (parent.parent_id !== null) throw new Error('Subtasks cannot contain nested subtasks.')
  if (childId) {
    const child = requireTask(childId, db)
    const nested = db.prepare('SELECT 1 FROM tasks WHERE parent_id = ? LIMIT 1').get(childId)
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

export function writeTask(db: DatabaseSync, input: TaskCreateInput & {
  titleSource: TaskTitleSource
  status: TaskStatus
  source: TaskSource
  now: number
}): Task {
  assertTaskStatus(input.status)
  const title = input.title.trim()
  if (!title) throw new Error('Task title cannot be empty.')

  let projectKey = normalizedOptional(input.projectKey)
  const parentId = normalizedOptional(input.parentId)
  if (parentId) {
    const parent = parentForChild(parentId, undefined, db)
    if (projectKey !== null && projectKey !== parent.project_key) {
      throw new Error('A subtask must belong to the same project as its parent.')
    }
    projectKey = parent.project_key
  }

  const id = ulid(input.now)
  const triagedAt = input.status === 'inbox' ? null : input.now
  const doneAt = input.status === 'done' ? input.now : null
  db.prepare(`
    INSERT INTO tasks(
      id, short_id, project_key, parent_id, title, title_source, body, status,
      kind, assignee, due_date, priority, labels,
      source, origin_session_id, origin_automation_id, created_at, updated_at,
      triaged_at, done_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    nextShortId(db),
    projectKey,
    parentId,
    title,
    input.titleSource,
    input.body ?? '',
    input.status,
    input.kind === 'epic' ? 'epic' : 'task',
    normalizedOptional(input.assignee),
    normalizedOptional(input.dueDate),
    input.priority ?? null,
    JSON.stringify(input.labels ?? []),
    input.source,
    normalizedOptional(input.originSessionId),
    normalizedOptional(input.originAutomationId),
    input.now,
    input.now,
    triagedAt,
    doneAt,
  )
  appendTaskEvent(db, id, {
    kind: 'created',
    actor: ACTOR_BY_SOURCE[input.source] ?? 'user',
    to: input.status,
  }, input.now)
  return taskFromRow(requireTask(id, db))
}

export function listTasks(filter: TaskListFilter = {}): TaskListResult {
  const clauses: string[] = []
  const params: Array<string | null> = []
  const hasProjectKey = Object.prototype.hasOwnProperty.call(filter, 'projectKey')
  const hasParentId = Object.prototype.hasOwnProperty.call(filter, 'parentId')

  if (hasProjectKey) {
    if (filter.projectKey === null) clauses.push('project_key IS NULL')
    else {
      clauses.push('project_key = ?')
      params.push(filter.projectKey ?? null)
    }
  }
  if (hasParentId) {
    if (filter.parentId === null) clauses.push('parent_id IS NULL')
    else {
      clauses.push('parent_id = ?')
      params.push(filter.parentId ?? null)
    }
  }

  const statuses = filter.status === undefined
    ? []
    : Array.isArray(filter.status) ? filter.status : [filter.status]
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }

  if (filter.scope === 'inbox') clauses.push("project_key IS NULL AND status = 'inbox'")
  if (filter.scope === 'project') clauses.push('project_key IS NOT NULL')
  if (filter.scope === 'up_next') clauses.push("status IN ('todo', 'in_progress', 'in_review')")

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = taskRowSchema.array().parse(database().prepare(`
    ${TASK_SELECT}
    ${where}
    ORDER BY tasks.updated_at DESC, tasks.created_at DESC, tasks.id
  `).all(...params))
  return { tasks: rows.map(taskFromRow) }
}

export function commentsForTask(taskId: string, db: DatabaseSync): TaskComment[] {
  const rows = taskCommentRowSchema.array().parse(db.prepare(`
    SELECT * FROM task_comments
    WHERE task_id = ?
    ORDER BY created_at, id
  `).all(taskId))
  return rows.map(commentFromRow)
}

export async function createTask(input: TaskCreateInput): Promise<Task> {
  const task = withTx(() => {
    const projectKey = normalizedOptional(input.projectKey)
    const source = input.source ?? 'user'
    const status = input.status ?? (projectKey === null ? 'inbox' : 'todo')
    return writeTask(database(), {
      ...input,
      projectKey,
      source,
      status,
      titleSource: source === 'session' ? 'prompt' : 'manual',
      now: Date.now(),
    })
  })
  emitChanged()
  return task
}
