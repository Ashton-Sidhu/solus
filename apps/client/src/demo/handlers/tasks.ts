import { arg, optionalArg } from './args'
import type { Task, TaskCreateInput, TaskDetails, TaskLinkInput, TaskLinkKind, TaskLinkTarget, TaskLinkedTask, TaskListFilter, TaskUpdatePatch } from '@solus/contracts/task-types'
import { type DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

function taskDetails(store: DemoStore, id: string): TaskDetails {
  const task = store.getTask(id)
  // SAFETY: the demo's task fixtures store their comment list on `raw.comments`, in the
  // shape the local task provider writes.
  const raw = task.raw as { comments?: Array<{ id?: string; author?: { login?: string } | null; body: string; createdAt: string }> } | null
  const rawComments = raw?.comments ?? []
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
    links: store.taskLinksFor(id),
    events: [],
  }
}

export function registerTasksHandlers(backend: DemoServer, store: DemoStore): void {
  // The demo project is pointed at Jira, so the rows it owns read as synced
  // tickets rather than local ones. The store is still the source of truth —
  // these handlers answer the upstream reads with the same rows, which is what
  // a healthy sync looks like from the renderer's side.
  backend.register('tasksProviderStatus', () => ({
    provider: 'jira',
    ok: true,
    reason: 'ok',
    message: 'Synced with the ACME project in Jira.',
    scopeLabel: 'ACME',
    writableFields: ['title', 'body', 'status', 'labels', 'priority'],
    statuses: ['todo', 'in_progress', 'in_review', 'done'],
    auth: { connected: true, login: 'acme-dev' },
  }))
  // Every upstream call takes `cwd` first and answers with a `Task`, not the
  // detail bundle the local reads return.
  backend.register('tasksListUpstream', () => store.listTasks())
  backend.register('tasksGetUpstream', (args) => store.getTask(arg<string>(args, 1)))
  backend.register('tasksUpdateUpstream', (args) => {
    const id = arg<string>(args, 1)
    const patch = arg<TaskUpdatePatch>(args, 2)
    // SAFETY: `TaskUpdatePatch` names a subset of `Task`'s own mutable fields.
    const task = store.updateTask(id, { ...patch } as Partial<Task>)
    backend.broadcast('tasks.invalidated', {})
    return task
  })
  backend.register('tasksCommentUpstream', (args) => {
    const id = arg<string>(args, 1)
    store.commentTask(id, arg<string>(args, 2))
    backend.broadcast('tasks.invalidated', {})
    return store.getTask(id)
  })
  backend.register('tasksList', (args) => {
    const filter = optionalArg<TaskListFilter>(args, 0)
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
  backend.register('tasksGet', (args) => taskDetails(store, arg<string>(args, 0)))
  backend.register('tasksSessions', (args) => {
    const taskId = optionalArg<string>(args, 0)
    const sessions = store.taskSessions()
    return taskId ? { [taskId]: sessions[taskId] ?? [] } : sessions
  })
  backend.register('tasksUpdate', (args) => {
    const id = arg<string>(args, 0)
    const patch = arg<TaskUpdatePatch>(args, 1)
    // SAFETY: `TaskUpdatePatch` names a subset of `Task`'s own mutable fields.
    const task = store.updateTask(id, { ...patch } as Partial<Task>)
    backend.broadcast('tasks.invalidated', {})
    return task
  })
  backend.register('tasksMarkRead', (args) => {
    const id = arg<string>(args, 0)
    const read = arg<boolean>(args, 1)
    const task = store.updateTask(id, { lastReadAt: read ? Date.now() : undefined })
    backend.broadcast('tasks.invalidated', {})
    return task
  })

  backend.register('tasksRecordActivity', (args) => {
    const id = arg<string>(args, 0)
    const existing = store.getTask(id)
    const update: Partial<Task> = {}
    if (existing?.status === 'done' || existing?.status === 'dropped') {
      update.status = 'in_progress'
      update.doneAt = undefined
    }
    const task = store.updateTask(id, update)
    backend.broadcast('tasks.invalidated', {})
    return task
  })
  backend.register('tasksCreate', (args) => {
    const input = arg<TaskCreateInput>(args, 0)
    // SAFETY: `TaskCreateInput` names a subset of `Task`'s own fields.
    const task = store.createTask(input as Partial<Task>)
    backend.broadcast('tasks.invalidated', {})
    return task
  })
  backend.register('tasksComment', (args) => {
    const id = arg<string>(args, 0)
    const body = arg<string>(args, 1)
    store.commentTask(id, body)
    backend.broadcast('tasks.invalidated', {})
    return taskDetails(store, id)
  })
  backend.register('tasksDelete', (args) => {
    const deleted = store.deleteTask(arg<string>(args, 0))
    if (deleted) backend.broadcast('tasks.invalidated', {})
    return deleted
  })
  backend.register('tasksLinkSession', (args) => {
    const taskId = arg<string>(args, 0)
    const sessionId = arg<string>(args, 1)
    store.linkTaskSession(taskId, sessionId)
    backend.broadcast('tasks.invalidated', {})
  })
  backend.register('tasksLink', (args) => {
    const taskId = arg<string>(args, 0)
    const input = arg<TaskLinkInput>(args, 1)
    store.linkTask(taskId, input)
    backend.broadcast('tasks.invalidated', {})
    return taskDetails(store, taskId)
  })
  backend.register('tasksUnlink', (args) => {
    const taskId = arg<string>(args, 0)
    const kind = arg<TaskLinkKind>(args, 1)
    const targetKey = arg<string>(args, 2)
    const targetScope = optionalArg<string>(args, 3)
    store.unlinkTask(taskId, kind, targetKey, targetScope ?? '')
    backend.broadcast('tasks.invalidated', {})
    return taskDetails(store, taskId)
  })
  backend.register('tasksLinkedTo', (args) => {
    const targets = arg<TaskLinkTarget[]>(args, 0)
    const linked: TaskLinkedTask[] = []
    for (const task of store.listTasks().tasks) {
      for (const link of store.taskLinksFor(task.id)) {
        const wanted = targets.some((target) =>
          target.kind === link.kind && target.targetScope === link.targetScope && target.targetKey === link.targetKey)
        if (!wanted) continue
        linked.push({
          taskId: task.id,
          kind: link.kind,
          targetScope: link.targetScope,
          targetKey: link.targetKey,
          title: task.title,
          status: task.status,
          shortId: task.shortId,
          projectKey: task.projectKey,
        })
      }
    }
    return linked
  })
  backend.register('tasksAttachArtifact', (args) => {
    // The demo has no browser to render a still with; the comment stands in
    // for the one the host would file.
    const taskId = arg<string>(args, 0)
    store.commentTask(taskId, 'Interactive artifact preview attached.')
    backend.broadcast('tasks.invalidated', {})
    return taskDetails(store, taskId)
  })
  backend.register('tasksForSession', (args) => {
    const sessionId = arg<string>(args, 0)
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
