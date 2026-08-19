import type { PrepareSessionTaskResult } from '@solus/contracts/task-types'
import {
  commentOnUpstreamTask,
  getUpstreamTask,
  listUpstreamTasks,
  taskProviderStatus,
  updateUpstreamTask,
} from '../../tasks/upstream'
import { createTask, listTasks } from '../../tasks/task-store'
import { Task, taskSnapshot } from '../../tasks/task'
import { readLatestTaskPrLinks } from '../../tasks/task-links'
import { attachLinkedContent } from '../../tasks/linked-content'
import { prepareSessionTask, rekeyTaskSessionLinks, taskSessions, tasksForSession } from '../../tasks/task-sessions'
import { markTaskRead, recordTaskActivity, snoozeTask } from '../../tasks/task-lifecycle'
import { getDb } from '../../db'
import {
  importTaskTickets,
  listTaskCandidates,
  publishTask,
  pullTaskSoon,
  startTaskSyncEngine,
  syncTasksNow,
} from '../../tasks/sync-engine'
import type { SolusServer } from '../server'

/** Global native-task RPCs plus project-scoped upstream-provider reads/writes. */
export function registerTasksHandlers(server: SolusServer): void {
  startTaskSyncEngine()
  server.register('tasksProviderStatus', (args) => {
    const [cwd, opts] = args
    return taskProviderStatus(cwd, opts ?? {})
  })

  server.register('tasksListUpstream', (args) => {
    const [cwd, opts] = args
    return listUpstreamTasks(cwd, opts ?? {})
  })

  server.register('tasksGetUpstream', (args) => {
    const [cwd, id] = args
    return getUpstreamTask(cwd, id)
  })

  server.register('tasksUpdateUpstream', (args) => {
    const [cwd, id, patch] = args
    return updateUpstreamTask(cwd, id, patch)
  })

  server.register('tasksCommentUpstream', (args) => {
    const [cwd, id, body] = args
    return commentOnUpstreamTask(cwd, id, body)
  })

  server.register('tasksListCandidates', (args) => {
    const [cwd, options] = args
    return listTaskCandidates(cwd, options)
  })

  server.register('tasksImport', (args) => {
    const [cwd, externalIds] = args
    return importTaskTickets(cwd, externalIds)
  })

  server.register('tasksPublish', (args) => {
    const [id, cwd] = args
    return publishTask(id, cwd)
  })

  server.register('tasksSyncNow', (args) => {
    const [id] = args
    return syncTasksNow(id)
  })

  server.register('tasksList', (args) => {
    const [filter] = args
    return listTasks(filter)
  })

  server.register('tasksSidebarSnapshot', () => {
    // Keep both reads inside one synchronous handler turn. This is the
    // renderer's atomic ownership boundary; focused callers can still use the
    // older list/link methods independently.
    return {
      tasks: listTasks().tasks,
      sessionsByTask: taskSessions(),
      prLinksByTask: readLatestTaskPrLinks(getDb()),
    }
  })

  server.register('tasksGet', async (args) => {
    const [id] = args
    const details = await (await Task.byId(id)).details()
    if (details.externalLink) pullTaskSoon(id)
    return details
  })

  server.register('tasksCreate', (args) => {
    const [input] = args
    return createTask(input)
  })

  server.register('tasksUpdate', async (args) => {
    const [id, patch] = args
    return (await (await Task.byId(id)).update(patch)).record()
  })

  server.register('tasksSnooze', (args) => {
    const [id, input] = args
    return snoozeTask(id, input)
  })

  server.register('tasksMarkRead', (args) => {
    const [id, read] = args
    return markTaskRead(id, read)
  })

  server.register('tasksRecordActivity', (args) => {
    const [id] = args
    return recordTaskActivity(id)
  })

  server.register('tasksDelete', async (args) => {
    const [id] = args
    return (await Task.byId(id)).delete()
  })

  server.register('tasksComment', async (args) => {
    const [id, body, options] = args
    return (await Task.byId(id)).comment(body, options)
  })

  server.register('tasksPublishComments', async (args) => {
    const [id, commentIds] = args
    return (await Task.byId(id)).publishComments(commentIds)
  })

  server.register('tasksLinkSession', async (args) => {
    const [taskId, sessionId, role, execution, branch] = args
    return (await Task.byId(taskId)).linkSession(sessionId, role ?? 'working', { execution, branch })
  })

  server.register('tasksUnlinkSession', async (args) => {
    const [taskId, sessionId] = args
    return (await Task.byId(taskId)).unlinkSession(sessionId)
  })

  /** A provider handoff happens on the execution host. For a dispatched run,
   * the task attempt belongs to another host, so the client forwards the stable
   * identity change here instead of leaving the old provider attempt behind. */
  server.register('tasksRekeySession', (args) => {
    const [sourceSessionId, targetSessionId] = args
    rekeyTaskSessionLinks(sourceSessionId, targetSessionId)
  })

  server.register('tasksLink', async (args) => {
    const [taskId, input] = args
    return (await Task.byId(taskId)).link(input)
  })

  server.register('tasksUnlink', async (args) => {
    const [taskId, kind, targetKey, targetScope] = args
    return (await Task.byId(taskId)).unlink(kind, targetKey, targetScope ?? '')
  })

  server.register('tasksSessions', (args) => {
    const [taskId] = args
    return taskSessions(taskId)
  })

  server.register('tasksForSession', (args) => {
    const [sessionId] = args
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
    const [input] = args
    const task = await prepareSessionTask(input)
    // The snapshot rides the same round trip a dispatching client already makes
    // (docs/plans/dispatch-parity.md): the execution host cannot read this
    // host's store, so the client ships the state — including linked works and
    // plans in full — with the prompt.
    const snapshot = task && input.includeSnapshot
      ? await attachLinkedContent(await taskSnapshot(task.id))
      : null
    return { task, snapshot } satisfies PrepareSessionTaskResult
  })

  /** A dispatched session's follow-up prompts re-ship the packet, so the client
   *  re-reads the task's live state from this host before each send. */
  server.register('tasksSnapshot', async (args) => {
    const [taskId] = args
    return attachLinkedContent(await taskSnapshot(taskId))
  })
}
