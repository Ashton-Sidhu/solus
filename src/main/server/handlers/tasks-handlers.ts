import type {
  TaskCreateInput,
  TaskLinkInput,
  TaskLinkKind,
  TaskListFilter,
  TaskSessionRole,
  TaskUpdatePatch,
} from '../../../shared/task-types'
import {
  commentOnUpstreamTask,
  getUpstreamTask,
  listUpstreamTasks,
  taskProviderStatus,
  updateUpstreamTask,
} from '../../tasks/upstream'
import { createTask, listTasks } from '../../tasks/task-store'
import { Task } from '../../tasks/task'
import { taskSessions, tasksForSession } from '../../tasks/task-sessions'
import type { SolusServer } from '../server'

/** Global native-task RPCs plus project-scoped upstream-provider reads/writes. */
export function registerTasksHandlers(server: SolusServer): void {
  server.register('tasksProviderStatus', (args) => {
    const [cwd, opts] = args as [string, { checkAccess?: boolean } | undefined]
    return taskProviderStatus(cwd, opts ?? {})
  })

  server.register('tasksListUpstream', (args) => {
    const [cwd, opts] = args as [string, { refresh?: boolean } | null | undefined]
    return listUpstreamTasks(cwd, opts ?? {})
  })

  server.register('tasksGetUpstream', (args) => {
    const [cwd, id] = args as [string, string]
    return getUpstreamTask(cwd, id)
  })

  server.register('tasksUpdateUpstream', (args) => {
    const [cwd, id, patch] = args as [string, string, TaskUpdatePatch]
    return updateUpstreamTask(cwd, id, patch)
  })

  server.register('tasksCommentUpstream', (args) => {
    const [cwd, id, body] = args as [string, string, string]
    return commentOnUpstreamTask(cwd, id, body)
  })

  server.register('tasksList', (args) => {
    const [filter] = args as [TaskListFilter | undefined]
    return listTasks(filter)
  })

  server.register('tasksGet', async (args) => {
    const [id] = args as [string]
    return (await Task.byId(id)).details()
  })

  server.register('tasksCreate', (args) => {
    const [input] = args as [TaskCreateInput]
    return createTask(input)
  })

  server.register('tasksUpdate', async (args) => {
    const [id, patch] = args as [string, TaskUpdatePatch]
    return (await (await Task.byId(id)).update(patch)).record()
  })

  server.register('tasksDelete', async (args) => {
    const [id] = args as [string]
    return (await Task.byId(id)).delete()
  })

  server.register('tasksComment', async (args) => {
    const [id, body] = args as [string, string]
    return (await Task.byId(id)).comment(body)
  })

  server.register('tasksLinkSession', async (args) => {
    const [taskId, sessionId, role] = args as [string, string, TaskSessionRole | undefined]
    return (await Task.byId(taskId)).linkSession(sessionId, role ?? 'working')
  })

  server.register('tasksLink', async (args) => {
    const [taskId, input] = args as [string, TaskLinkInput]
    return (await Task.byId(taskId)).link(input)
  })

  server.register('tasksUnlink', async (args) => {
    const [taskId, kind, targetKey, targetScope] = args as
      [string, TaskLinkKind, string, string | undefined]
    return (await Task.byId(taskId)).unlink(kind, targetKey, targetScope ?? '')
  })

  server.register('tasksSessions', (args) => {
    const [taskId] = args as [string | undefined]
    return taskSessions(taskId)
  })

  server.register('tasksForSession', (args) => {
    const [sessionId] = args as [string]
    return tasksForSession(sessionId)
  })
}
