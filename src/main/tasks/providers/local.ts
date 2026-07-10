import { randomUUID } from 'node:crypto'
import { getDb, withTx } from '../../db'
import type { Task, TaskCommentData, TaskList, TaskPr, TaskProvider, TaskStatus } from '../../../shared/task-types'

interface TaskRow {
  id: string
  title: string
  body: string | null
  status: TaskStatus
  kind: Task['kind']
  parent_id: string | null
  assignee: string | null
  due_date: string | null
  priority: Task['priority'] | null
  branch: string | null
  pr: string | null
  labels: string | null
  raw: string | null
  updated_at: number
}

/** Shape we stash in a local task's `raw` so the detail view's `taskHydration`
 *  (which reads `raw.comments`) renders local comments the same way it does
 *  GitHub's. Local has no real author identity, so comments are attributed to
 *  "You". */
interface LocalRaw {
  comments: { author: { login: string } | null; body: string; createdAt: string }[]
}

function localRaw(raw: unknown): LocalRaw {
  if (raw && typeof raw === 'object' && 'comments' in raw) return raw as LocalRaw
  return { comments: [] }
}

function epochMs(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid task timestamp: ${value}`)
  return timestamp
}

function jsonValue<T>(value: string | null, fallback: T): T {
  return value === null ? fallback : JSON.parse(value) as T
}

function insertTask(projectKey: string, task: Task): void {
  const updatedAt = epochMs(task.updatedAt)
  getDb().prepare(`
    INSERT INTO tasks(
      id, project_key, title, body, status, kind, parent_id, assignee,
      due_date, priority, branch, pr, labels, raw, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    projectKey,
    task.title,
    task.body,
    task.status,
    task.kind,
    task.parentId ?? null,
    task.assignee ?? null,
    task.dueDate ?? null,
    task.priority ?? null,
    task.branch ?? null,
    task.pr ? JSON.stringify(task.pr) : null,
    JSON.stringify(task.labels),
    task.raw === undefined ? null : JSON.stringify(task.raw),
    updatedAt,
    updatedAt,
  )
}

const VALID_STATUS = new Set<TaskStatus>(['open', 'in_progress', 'done'])

/**
 * Local task provider — full CRUD against SQLite. It owns the data (no
 * upstream), so it implements every optional mutator. Epics are derived from
 * child tasks' `parentId`; no reverse child list is stored.
 */
export class LocalTaskProvider implements TaskProvider {
  readonly id = 'local' as const

  constructor(private readonly projectKey: string) {}

  private taskForRead(row: TaskRow, childIds?: string[]): Task {
    const task: Task = {
      id: row.id,
      providerId: 'local',
      kind: row.kind,
      title: row.title,
      body: row.body ?? '',
      status: row.status,
      url: null,
      assignee: row.assignee ?? undefined,
      labels: jsonValue(row.labels, []),
      parentId: row.parent_id ?? undefined,
      dueDate: row.due_date ?? undefined,
      priority: row.priority ?? undefined,
      branch: row.branch ?? undefined,
      pr: jsonValue<TaskPr | undefined>(row.pr, undefined),
      updatedAt: new Date(row.updated_at).toISOString(),
      raw: jsonValue<unknown>(row.raw, null),
      canEditPlanningFields: true,
    }
    if (task.kind === 'epic') task.childIds = childIds ?? []
    return task
  }

  private row(id: string): TaskRow | undefined {
    return getDb().prepare(`
      SELECT id, title, body, status, kind, parent_id, assignee, due_date,
             priority, branch, pr, labels, raw, updated_at
      FROM tasks
      WHERE project_key = ? AND id = ?
    `).get(this.projectKey, id) as TaskRow | undefined
  }

  private childIds(id: string): string[] {
    const rows = getDb().prepare(`
      SELECT id
      FROM tasks
      WHERE project_key = ? AND parent_id = ?
      ORDER BY rowid
    `).all(this.projectKey, id) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  async listTasks(): Promise<TaskList> {
    // assignedToMe is a no-op locally — there's no viewer identity to scope by.
    const rows = getDb().prepare(`
      SELECT id, title, body, status, kind, parent_id, assignee, due_date,
             priority, branch, pr, labels, raw, updated_at
      FROM tasks
      WHERE project_key = ?
      ORDER BY updated_at DESC, rowid
    `).all(this.projectKey) as unknown as TaskRow[]
    const childRows = getDb().prepare(`
      SELECT id, parent_id
      FROM tasks
      WHERE project_key = ? AND parent_id IS NOT NULL
      ORDER BY rowid
    `).all(this.projectKey) as Array<{ id: string; parent_id: string }>
    const children = new Map<string, string[]>()
    for (const row of childRows) {
      const ids = children.get(row.parent_id) ?? []
      ids.push(row.id)
      children.set(row.parent_id, ids)
    }
    return { tasks: rows.map((row) => this.taskForRead(row, children.get(row.id))) }
  }

  async getTask(id: string): Promise<Task> {
    const row = this.row(id)
    if (!row) throw new Error(`Local task ${id} not found`)
    return this.taskForRead(row, row.kind === 'epic' ? this.childIds(id) : undefined)
  }

  async createTask(input: Partial<Task>): Promise<Task> {
    const now = new Date().toISOString()
    const kind = input.kind === 'epic' ? 'epic' : 'task'
    const task: Task = {
      id: randomUUID(),
      providerId: 'local',
      kind,
      title: input.title?.trim() || 'Untitled task',
      body: input.body ?? '',
      status: VALID_STATUS.has(input.status as TaskStatus) ? (input.status as TaskStatus) : 'open',
      url: null,
      assignee: input.assignee,
      labels: input.labels ?? [],
      parentId: kind === 'task' ? input.parentId : undefined,
      dueDate: input.dueDate,
      priority: input.priority,
      branch: input.branch,
      pr: input.pr,
      updatedAt: now,
      raw: null,
    }
    withTx(() => insertTask(this.projectKey, task))
    return this.taskForRead(this.row(task.id)!)
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    return withTx(() => {
      const row = this.row(id)
      if (!row) throw new Error(`Local task ${id} not found`)
      const task = this.taskForRead(row)

      if (patch.title !== undefined) task.title = patch.title
      if (patch.body !== undefined) task.body = patch.body
      if (patch.labels !== undefined) task.labels = patch.labels
      if (patch.status !== undefined && VALID_STATUS.has(patch.status)) task.status = patch.status
      // Outcome fields — empty string clears, so an edit can remove a stale value.
      if (patch.assignee !== undefined) task.assignee = patch.assignee || undefined
      if (patch.dueDate !== undefined) task.dueDate = patch.dueDate || undefined
      if (patch.priority !== undefined) task.priority = patch.priority || undefined
      if (patch.branch !== undefined) task.branch = patch.branch || undefined
      if (patch.pr !== undefined) task.pr = patch.pr?.url ? patch.pr : undefined
      if (patch.parentId !== undefined && patch.parentId !== task.parentId) {
        task.parentId = patch.parentId || undefined
      }
      task.updatedAt = new Date().toISOString()
      getDb().prepare(`
        UPDATE tasks
        SET title = ?, body = ?, status = ?, parent_id = ?, assignee = ?,
            due_date = ?, priority = ?, branch = ?, pr = ?, labels = ?,
            raw = ?, updated_at = ?
        WHERE project_key = ? AND id = ?
      `).run(
        task.title,
        task.body,
        task.status,
        task.parentId ?? null,
        task.assignee ?? null,
        task.dueDate ?? null,
        task.priority ?? null,
        task.branch ?? null,
        task.pr ? JSON.stringify(task.pr) : null,
        JSON.stringify(task.labels),
        JSON.stringify(task.raw),
        epochMs(task.updatedAt),
        this.projectKey,
        id,
      )
      const updated = this.row(id)!
      return this.taskForRead(updated, updated.kind === 'epic' ? this.childIds(id) : undefined)
    })
  }

  async deleteTask(id: string): Promise<boolean> {
    return withTx(() => {
      if (!this.row(id)) return false
      // Orphan children instead of cascading; children are derived from parentId.
      getDb().prepare('UPDATE tasks SET parent_id = NULL WHERE project_key = ? AND parent_id = ?')
        .run(this.projectKey, id)
      getDb().prepare('DELETE FROM tasks WHERE project_key = ? AND id = ?').run(this.projectKey, id)
      return true
    })
  }

  /** System write for the auto-captured PR: unlike `updateTask` it does NOT bump
   *  `updatedAt` — the capture runs on every detail-view read, and a read must
   *  not reorder the task in the "Updated" sort. */
  async refreshPr(id: string, pr: TaskPr | undefined): Promise<Task> {
    return withTx(() => {
      const row = this.row(id)
      if (!row) throw new Error(`Local task ${id} not found`)
      getDb().prepare('UPDATE tasks SET pr = ? WHERE project_key = ? AND id = ?')
        .run(pr?.url ? JSON.stringify(pr) : null, this.projectKey, id)
      return this.taskForRead(this.row(id)!, row.kind === 'epic' ? this.childIds(id) : undefined)
    })
  }

  /** Append a comment to the task's local `raw` store. Mirrors GitHub's
   *  `postComment` so the detail view can offer comment composition uniformly;
   *  the optional `TaskProvider.postComment` is what callers feature-detect. */
  async postComment(id: string, body: string): Promise<TaskCommentData> {
    return withTx(() => {
      const row = this.row(id)
      if (!row) throw new Error(`Local task ${id} not found`)
      const raw = localRaw(jsonValue<unknown>(row.raw, null))
      const comment: TaskCommentData = { author: { login: 'You' }, body, createdAt: new Date().toISOString() }
      raw.comments.push(comment)
      getDb().prepare(`
        UPDATE tasks
        SET raw = ?, updated_at = ?
        WHERE project_key = ? AND id = ?
      `).run(JSON.stringify(raw), epochMs(comment.createdAt), this.projectKey, id)
      return comment
    })
  }
}
