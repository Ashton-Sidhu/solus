import type { Task } from '../../../shared/task-types'
import { listTasks, getTask, createTask, updateTask, deleteTask, postTaskComment, setTasksChangedNotifier } from '../../tasks/task-service'
import { linkTaskSession, taskSessions } from '../../tasks/task-links'
import type { SolusServer } from '../server'

/** RPC surface for the renderer to browse and mutate tasks through whichever
 *  provider the project is bound to. All calls take the project `cwd` so the
 *  service can resolve the provider; the renderer never sees a provider type. */
export function registerTasksHandlers(server: SolusServer): void {
  // Every task mutation (renderer, agent tool, or session write-back) funnels
  // through task-service; fan it out so open task views can refresh live.
  setTasksChangedNotifier((cwd) => server.broadcast('tasks-changed', cwd))

  server.register('tasksList', (args) => {
    const [cwd, opts] = args as [string, { assignedToMe?: boolean } | undefined]
    return listTasks(cwd, opts ?? {})
  })

  server.register('tasksGet', (args) => {
    const [cwd, id] = args as [string, string]
    return getTask(cwd, id)
  })

  server.register('tasksCreate', (args) => {
    const [cwd, input] = args as [string, Partial<Task>]
    return createTask(cwd, input)
  })

  server.register('tasksUpdate', (args) => {
    const [cwd, id, patch] = args as [string, string, Partial<Task>]
    return updateTask(cwd, id, patch)
  })

  server.register('tasksDelete', (args) => {
    const [cwd, id] = args as [string, string]
    return deleteTask(cwd, id)
  })

  server.register('tasksComment', (args) => {
    const [cwd, id, body] = args as [string, string, string]
    return postTaskComment(cwd, id, body)
  })

  // Two-way task↔session link, kept in a local sidecar (never written upstream)
  // so the card can show which tasks have live work and jump back to it.
  server.register('tasksLinkSession', (args) => {
    const [cwd, taskId, sessionId] = args as [string, string, string]
    return linkTaskSession(cwd, taskId, sessionId)
  })

  server.register('tasksSessions', (args) => {
    const [cwd] = args as [string]
    return taskSessions(cwd)
  })
}
