import type { Task } from '../../../../src/shared/task-types'
import { DEMO_PROJECT, type DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerTasksHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('tasksProviderStatus', () => ({
    provider: 'local',
    ok: true,
    reason: 'ok',
    message: 'Using Solus demo tasks for this project.',
  }))
  backend.register('tasksList', () => store.listTasks())
  backend.register('tasksGet', (args) => store.getTask(args[1] as string))
  backend.register('tasksSessions', () => store.taskSessions())
  backend.register('tasksUpdate', (args) => {
    const [cwd, id, patch] = args as [string, string, Partial<Task>]
    const task = store.updateTask(id, patch)
    backend.broadcast('tasks-changed', cwd || DEMO_PROJECT)
    return task
  })
  backend.register('tasksCreate', (args) => {
    const [cwd, input] = args as [string, Partial<Task>]
    const task = store.createTask(input)
    backend.broadcast('tasks-changed', cwd || DEMO_PROJECT)
    return task
  })
  backend.register('tasksComment', (args) => {
    const [cwd, id, body] = args as [string, string, string]
    const task = store.commentTask(id, body)
    backend.broadcast('tasks-changed', cwd || DEMO_PROJECT)
    return task
  })
  backend.register('tasksDelete', (args) => {
    const [cwd, id] = args as [string, string]
    const deleted = store.deleteTask(id)
    if (deleted) backend.broadcast('tasks-changed', cwd || DEMO_PROJECT)
    return deleted
  })
  backend.register('tasksLinkSession', (args) => {
    const [cwd, taskId, sessionId] = args as [string, string, string]
    store.linkTaskSession(taskId, sessionId)
    backend.broadcast('tasks-changed', cwd || DEMO_PROJECT)
  })
}
