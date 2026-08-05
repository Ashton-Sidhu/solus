import type { DatabaseSync } from 'node:sqlite'
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
  TaskPr,
  TaskPriority,
  TaskSource,
  TaskStatus,
  TaskTitleSource,
} from '../../shared/task-types'

const log = createLogger('main', 'task-store')
const TASK_STATUSES = new Set<TaskStatus>([
  'inbox',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'dropped',
])

interface TaskRow {
  id: string
  short_id: number | null
  project_key: string | null
  parent_id: string | null
  title: string
  title_source: TaskTitleSource
  body: string
  status: TaskStatus
  kind: Task['kind']
  assignee: string | null
  due_date: string | null
  priority: TaskPriority | null
  labels: string
  branch: string | null
  pr: string | null
  worktree_key: string | null
  source: TaskSource
  origin_session_id: string | null
  origin_automation_id: string | null
  created_at: number
  updated_at: number
  triaged_at: number | null
  done_at: number | null
}

interface TaskCommentRow {
  id: string
  task_id: string
  author: string | null
  source: TaskComment['source']
  external_id: string | null
  origin_session_id: string | null
  body: string
  created_at: number
}

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

export function jsonValue<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    providerId: 'local',
    ...(row.short_id === null ? {} : { shortId: row.short_id }),
    projectKey: row.project_key,
    kind: row.kind,
    title: row.title,
    titleSource: row.title_source,
    body: row.body,
    status: row.status,
    url: null,
    ...(row.assignee === null ? {} : { assignee: row.assignee }),
    labels: jsonValue<string[]>(row.labels, []),
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    ...(row.due_date === null ? {} : { dueDate: row.due_date }),
    ...(row.priority === null ? {} : { priority: row.priority }),
    ...(row.branch === null ? {} : { branch: row.branch }),
    ...(row.pr === null ? {} : { pr: jsonValue<TaskPr | undefined>(row.pr, undefined) }),
    canEditPlanningFields: true,
    ...(row.worktree_key === null ? {} : { worktreeKey: row.worktree_key }),
    source: row.source,
    ...(row.origin_session_id === null ? {} : { originSessionId: row.origin_session_id }),
    ...(row.origin_automation_id === null ? {} : { originAutomationId: row.origin_automation_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.triaged_at === null ? {} : { triagedAt: row.triaged_at }),
    ...(row.done_at === null ? {} : { doneAt: row.done_at }),
  }
}

function commentFromRow(row: TaskCommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    source: row.source,
    ...(row.external_id === null ? {} : { externalId: row.external_id }),
    ...(row.origin_session_id === null ? {} : { originSessionId: row.origin_session_id }),
    body: row.body,
    createdAt: row.created_at,
  }
}

export function database(): DatabaseSync {
  return getDb()
}

function taskRow(id: string, db: DatabaseSync = database()): TaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined
}

/** Internal record read used by the session-link store. */
export function loadTaskRecord(id: string): Task | null {
  const row = taskRow(id)
  return row ? taskFromRow(row) : null
}

export function listTaskChildren(parentId: string): Task[] {
  const rows = database().prepare(`
    SELECT * FROM tasks
    WHERE parent_id = ?
    ORDER BY updated_at DESC, created_at DESC, id
  `).all(parentId) as unknown as TaskRow[]
  return rows.map(taskFromRow)
}

export function requireTask(id: string, db: DatabaseSync = database()): TaskRow {
  const row = taskRow(id, db)
  if (!row) throw new Error(`Task ${id} not found.`)
  return row
}

function nextShortId(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(short_id), 0) + 1 AS next_id FROM tasks').get() as { next_id: number }
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
const ACTOR_BY_SOURCE: Record<TaskSource, TaskActor> = {
  user: 'user',
  agent: 'agent',
  session: 'agent',
  automation: 'automation',
  import: 'system',
}

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
  let worktreeKey = normalizedOptional(input.worktreeKey)
  const parentId = normalizedOptional(input.parentId)
  if (parentId) {
    const parent = parentForChild(parentId, undefined, db)
    if (projectKey !== null && projectKey !== parent.project_key) {
      throw new Error('A subtask must belong to the same project as its parent.')
    }
    if (worktreeKey !== null && parent.worktree_key !== null && worktreeKey !== parent.worktree_key) {
      throw new Error('A subtask must belong to the same worktree as its parent.')
    }
    projectKey = parent.project_key
    worktreeKey = parent.worktree_key
  }

  const id = ulid(input.now)
  const triagedAt = input.status === 'inbox' ? null : input.now
  const doneAt = input.status === 'done' ? input.now : null
  db.prepare(`
    INSERT INTO tasks(
      id, short_id, project_key, parent_id, title, title_source, body, status,
      kind, assignee, due_date, priority, labels, branch, worktree_key,
      source, origin_session_id, origin_automation_id, created_at, updated_at,
      triaged_at, done_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    normalizedOptional(input.branch),
    worktreeKey,
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
  const rows = database().prepare(`
    SELECT * FROM tasks
    ${where}
    ORDER BY updated_at DESC, created_at DESC, id
  `).all(...params) as unknown as TaskRow[]
  return { tasks: rows.map(taskFromRow) }
}

export function commentsForTask(taskId: string, db: DatabaseSync): TaskComment[] {
  const rows = db.prepare(`
    SELECT * FROM task_comments
    WHERE task_id = ?
    ORDER BY created_at, id
  `).all(taskId) as unknown as TaskCommentRow[]
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
