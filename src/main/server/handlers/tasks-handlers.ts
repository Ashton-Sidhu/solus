import type {
  PrepareSessionTaskRequest,
  PrepareSessionTaskResult,
  SessionExecutionHost,
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
import { Task, taskSnapshot } from '../../tasks/task'
import { prepareSessionTask, taskSessions, tasksForSession } from '../../tasks/task-sessions'
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

  server.register('tasksSidebarSnapshot', () => {
    // Keep both reads inside one synchronous handler turn. This is the
    // renderer's atomic ownership boundary; focused callers can still use the
    // older list/link methods independently.
    return { tasks: listTasks().tasks, sessionsByTask: taskSessions() }
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
    const [taskId, sessionId, role, execution] = args as [
      string,
      string,
      TaskSessionRole | undefined,
      SessionExecutionHost | null | undefined,
    ]
    return (await Task.byId(taskId)).linkSession(sessionId, role ?? 'working', { execution })
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

  /**
   * The first-dispatch mint, addressed to the host that owns the project rather
   * than performed as a side effect on whichever host runs the agent. A
   * dispatched session runs elsewhere and files here, so only the client knows
   * both hosts and must name this one. The session link follows separately, once
   * the execution host has issued a session id.
   */
  server.register('tasksPrepareForSession', async (args) => {
    const [input] = args as [PrepareSessionTaskRequest]
    const task = await prepareSessionTask(input)
    // The snapshot rides the same round trip a dispatching client already makes
    // (docs/plans/dispatch-parity.md): the execution host cannot read this
    // host's store, so the client ships the state with the prompt.
    const snapshot = task && input.includeSnapshot ? await taskSnapshot(task.id) : null
    return { task, snapshot } satisfies PrepareSessionTaskResult
  })

  /** A dispatched session's follow-up prompts re-ship the packet, so the client
   *  re-reads the task's live state from this host before each send. */
  server.register('tasksSnapshot', async (args) => {
    const [taskId] = args as [string]
    return taskSnapshot(taskId)
  })
}
