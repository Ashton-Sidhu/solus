import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createLogger } from '../../logger'
import { writeJson } from '../../project-config/json-file'
import type { Task, TaskProvider, TaskStatus } from '../../../shared/task-types'

const log = createLogger('main', 'local-tasks')

// Local tasks live at ~/.solus/tasks/<project-key>.json. For a local project the
// store *is* the source of truth (no provider cache), so writes go straight here
// via an atomic temp+rename — a torn write would otherwise read as "no tasks".
const ROOT = join(homedir(), '.solus', 'tasks')

interface TaskStore {
  version: 1
  tasks: Record<string, Task>
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

function storePath(projectKey: string): string {
  return join(ROOT, `${projectKey}.json`)
}

const VALID_STATUS = new Set<TaskStatus>(['open', 'in_progress', 'done'])

/**
 * Local task provider — full CRUD against a per-project JSON store. It owns the
 * data (no upstream), so it implements every optional mutator. Epics are derived
 * from child tasks' `parentId`; no reverse child list is stored.
 */
export class LocalTaskProvider implements TaskProvider {
  readonly id = 'local' as const

  constructor(private readonly projectKey: string) {}

  private async read(): Promise<TaskStore> {
    const path = storePath(this.projectKey)
    if (!existsSync(path)) return { version: 1, tasks: {} }
    try {
      return JSON.parse(await readFile(path, 'utf8')) as TaskStore
    } catch (err) {
      log.error(`read(${this.projectKey}) failed: ${String(err)}`)
      return { version: 1, tasks: {} }
    }
  }

  private async write(store: TaskStore): Promise<void> {
    await writeJson(storePath(this.projectKey), store)
  }

  private taskForRead(task: Task, store: TaskStore): Task {
    const copy = { ...task, canEditPlanningFields: true }
    if (copy.kind === 'epic') {
      copy.childIds = Object.values(store.tasks)
        .filter((child) => child.parentId === copy.id)
        .map((child) => child.id)
    } else {
      delete copy.childIds
    }
    return copy
  }

  async listTasks(opts: { query?: string; assignedToMe?: boolean } = {}): Promise<Task[]> {
    const store = await this.read()
    let tasks = Object.values(store.tasks).map((t) => this.taskForRead(t, store))
    if (opts.query) {
      const q = opts.query.toLowerCase()
      tasks = tasks.filter((t) => t.title.toLowerCase().includes(q))
    }
    // assignedToMe is a no-op locally — there's no viewer identity to scope by.
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async getTask(id: string): Promise<Task> {
    const store = await this.read()
    const task = store.tasks[id]
    if (!task) throw new Error(`Local task ${id} not found`)
    return this.taskForRead(task, store)
  }

  async createTask(input: Partial<Task>): Promise<Task> {
    const store = await this.read()
    const now = new Date().toISOString()
    const id = randomUUID()
    const kind = input.kind === 'epic' ? 'epic' : 'task'
    const parentId = kind === 'task' ? input.parentId : undefined
    const task: Task = {
      id,
      providerId: 'local',
      kind,
      title: input.title?.trim() || 'Untitled task',
      body: input.body ?? '',
      status: VALID_STATUS.has(input.status as TaskStatus) ? (input.status as TaskStatus) : 'open',
      url: null,
      assignee: input.assignee,
      labels: input.labels ?? [],
      parentId,
      dueDate: input.dueDate,
      priority: input.priority,
      branch: input.branch,
      pr: input.pr,
      updatedAt: now,
      raw: null,
    }
    store.tasks[id] = task
    await this.write(store)
    return this.taskForRead(task, store)
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const store = await this.read()
    const task = store.tasks[id]
    if (!task) throw new Error(`Local task ${id} not found`)

    if (patch.title !== undefined) task.title = patch.title
    if (patch.body !== undefined) task.body = patch.body
    if (patch.assignee !== undefined) task.assignee = patch.assignee
    if (patch.labels !== undefined) task.labels = patch.labels
    if (patch.status !== undefined && VALID_STATUS.has(patch.status)) task.status = patch.status
    // Outcome fields — empty string clears, so an edit can remove a stale value.
    if (patch.dueDate !== undefined) task.dueDate = patch.dueDate || undefined
    if (patch.priority !== undefined) task.priority = patch.priority || undefined
    if (patch.branch !== undefined) task.branch = patch.branch || undefined
    if (patch.pr !== undefined) task.pr = patch.pr ?? undefined
    if (patch.parentId !== undefined && patch.parentId !== task.parentId) {
      task.parentId = patch.parentId || undefined
    }
    delete task.childIds
    task.updatedAt = new Date().toISOString()
    await this.write(store)
    return this.taskForRead(task, store)
  }

  async deleteTask(id: string): Promise<boolean> {
    const store = await this.read()
    const task = store.tasks[id]
    if (!task) return false
    // Orphan children instead of cascading; children are derived from parentId.
    for (const child of Object.values(store.tasks)) {
      if (child.parentId === id) child.parentId = undefined
    }
    delete store.tasks[id]
    await this.write(store)
    return true
  }

  /** Append a comment to the task's local `raw` store. Mirrors GitHub's
   *  `postComment` so the detail view can offer comment composition uniformly;
   *  the optional `TaskProvider.postComment` is what callers feature-detect. */
  async postComment(id: string, body: string): Promise<void> {
    const store = await this.read()
    const task = store.tasks[id]
    if (!task) throw new Error(`Local task ${id} not found`)
    const raw = localRaw(task.raw)
    raw.comments.push({ author: { login: 'You' }, body, createdAt: new Date().toISOString() })
    task.raw = raw
    task.updatedAt = new Date().toISOString()
    await this.write(store)
  }

}
