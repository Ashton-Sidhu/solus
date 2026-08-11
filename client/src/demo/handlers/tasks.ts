import type { Task, TaskCreateInput, TaskDetails, TaskLinkInput, TaskLinkKind, TaskListFilter, TaskUpdatePatch } from '../../../../src/shared/task-types'
import { type DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

function taskDetails(store: DemoStore, id: string): TaskDetails {
  const task = store.getTask(id)
  const rawComments = task.raw && typeof task.raw === 'object' && 'comments' in task.raw
    ? (task.raw as { comments?: Array<{ id?: string; author?: { login?: string } | null; body: string; createdAt: string }> }).comments ?? []
    : []
  return {
    task,
    subtasks: store.listTasks().tasks.filter((candidate) => candidate.parentId === id),
    comments: rawComments.map((comment, index) => ({
      id: comment.id ?? `${id}-comment-${index}`,
      taskId: id,
      author: comment.author?.login ?? null,
      source: 'local',
      body: comment.body,
      createdAt: Date.parse(comment.createdAt),
    })),
    attempts: store.taskSessions()[id] ?? [],
    links: store.taskLinksFor(id),
    events: [],
  }
}

export function registerTasksHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('tasksProviderStatus', () => ({
    provider: 'local',
    ok: true,
    reason: 'ok',
    message: 'Using Solus demo tasks for this project.',
  }))
  backend.register('tasksListUpstream', () => ({ tasks: [] }))
  backend.register('tasksGetUpstream', () => {
    throw new Error('The demo project has no upstream task provider.')
  })
  backend.register('tasksUpdateUpstream', () => {
    throw new Error('The demo project has no upstream task provider.')
  })
  backend.register('tasksCommentUpstream', () => {
    throw new Error('The demo project has no upstream task provider.')
  })
  backend.register('tasksList', (args) => {
    const [filter] = args as [TaskListFilter | undefined]
    const list = store.listTasks()
    return {
      tasks: list.tasks.filter((task) => {
        if (filter?.projectKey !== undefined && task.projectKey !== filter.projectKey) return false
        if (filter?.parentId !== undefined && task.parentId !== filter.parentId) return false
        if (filter?.status) {
          const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
          if (!statuses.includes(task.status)) return false
        }
        return true
      }),
    }
  })
  backend.register('tasksSidebarSnapshot', () => ({
    tasks: store.listTasks().tasks,
    sessionsByTask: store.taskSessions(),
  }))
  backend.register('tasksGet', (args) => taskDetails(store, args[0] as string))
  backend.register('tasksSessions', (args) => {
    const [taskId] = args as [string | undefined]
    const sessions = store.taskSessions()
    return taskId ? { [taskId]: sessions[taskId] ?? [] } : sessions
  })
  backend.register('tasksUpdate', (args) => {
    const [id, patch] = args as [string, TaskUpdatePatch]
    const task = store.updateTask(id, {
      ...patch,
      ...(patch.status === 'done'
        ? { snoozedUntil: undefined, snoozedAt: undefined, snoozeNote: undefined }
        : {}),
    } as Partial<Task>)
    backend.broadcast('tasks.invalidated', {})
    return task
  })
  backend.register('tasksSnooze', (args) => {
    const [id, input] = args as [string, { until: number | null; note?: string | null }]
    const task = store.updateTask(id, {
      snoozedUntil: input.until ?? undefined,
      snoozedAt: input.until === null ? undefined : Date.now(),
      snoozeNote: input.note?.trim() || undefined,
    })
    backend.broadcast('tasks.invalidated', {})
    return task
  })
  backend.register('tasksMarkRead', (args) => {
    const [id, read] = args as [string, boolean]
    const task = store.updateTask(id, { lastReadAt: read ? Date.now() : undefined })
    backend.broadcast('tasks.invalidated', {})
    return task
  })

  backend.register('tasksRecordActivity', (args) => {
    const [id] = args as [string]
    const task = store.updateTask(id, {
      snoozedUntil: undefined,
      snoozedAt: undefined,
      snoozeNote: undefined,
    })
    backend.broadcast('tasks.invalidated', {})
    return task
  })
  backend.register('tasksCreate', (args) => {
    const [input] = args as [TaskCreateInput]
    const task = store.createTask(input as Partial<Task>)
    backend.broadcast('tasks.invalidated', {})
    return task
  })
  backend.register('tasksComment', (args) => {
    const [id, body] = args as [string, string]
    store.commentTask(id, body)
    backend.broadcast('tasks.invalidated', {})
    return taskDetails(store, id)
  })
  backend.register('tasksDelete', (args) => {
    const [id] = args as [string]
    const deleted = store.deleteTask(id)
    if (deleted) backend.broadcast('tasks.invalidated', {})
    return deleted
  })
  backend.register('tasksLinkSession', (args) => {
    const [taskId, sessionId] = args as [string, string]
    store.linkTaskSession(taskId, sessionId)
    backend.broadcast('tasks.invalidated', {})
  })
  backend.register('tasksLink', (args) => {
    const [taskId, input] = args as [string, TaskLinkInput]
    store.linkTask(taskId, input)
    backend.broadcast('tasks.invalidated', {})
    return taskDetails(store, taskId)
  })
  backend.register('tasksUnlink', (args) => {
    const [taskId, kind, targetKey, targetScope] = args as [string, TaskLinkKind, string, string | undefined]
    store.unlinkTask(taskId, kind, targetKey, targetScope ?? '')
    backend.broadcast('tasks.invalidated', {})
    return taskDetails(store, taskId)
  })
  backend.register('tasksForSession', (args) => {
    const [sessionId] = args as [string]
    const sessions = store.taskSessions()
    const taskId = Object.entries(sessions).find(([, links]) => links.some((link) => link.sessionId === sessionId))?.[0]
    if (!taskId) return null
    const task = store.getTask(taskId)
    const parent = task.parentId ? store.getTask(task.parentId) : null
    const rootId = parent?.id ?? task.id
    const subtasks = store.listTasks().tasks.filter((candidate) => candidate.parentId === rootId)
    const siblings = task.parentId
      ? subtasks.filter((candidate) => candidate.id !== task.id)
      : []
    const attempts = [rootId, ...subtasks.map((candidate) => candidate.id)]
      .flatMap((candidateTaskId) => sessions[candidateTaskId] ?? [])
    return {
      task,
      parent,
      subtasks,
      siblings,
      attempts,
    }
  })
}
