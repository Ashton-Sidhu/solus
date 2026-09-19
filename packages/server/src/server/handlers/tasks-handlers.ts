import type { PrepareSessionTaskResult } from '@solus/contracts/task-types'
import {
  commentOnUpstreamTask,
  getUpstreamTask,
  listTaskAssigneeCandidates,
  listUpstreamTasks,
  taskProviderStatus,
  updateUpstreamTask,
} from '../../tasks/upstream'
import { createTask, listTasks } from '../../tasks/task-store'
import { Task, taskSnapshot } from '../../tasks/task'
import { readTasksLinkingTargets } from '../../tasks/task-links'
import { attachLinkedContent } from '../../tasks/linked-content'
import { attachArtifactToTask } from '../../tasks/task-artifacts'
import { prepareSessionTask, rekeyTaskSessionLinks, taskSessions, tasksForSession } from '../../tasks/task-sessions'
import { markTaskRead, recordTaskActivity } from '../../tasks/task-lifecycle'
import { getDatabase } from '../../db/database'
import { readTaskSidebarSnapshot } from '../../tasks/task-sidebar'
import {
  importTaskTickets,
  listTaskCandidates,
  publishTask,
  pullTaskSoon,
  startTaskSyncEngine,
  syncTasksNow,
} from '../../tasks/sync-engine'
import type { HandlerCtx, SolusServer } from '../server'
import { organizationOf } from '../principal'
import type { ShareManager } from '../../sharing/share-manager'
import { listInboxUpstream } from '../../tasks/inbox'
import type { Task as TaskRecord, TaskSidebarSnapshot } from '@solus/contracts/task-types'

/**
 * Global native-task RPCs plus project-scoped upstream-provider reads/writes.
 * A task is a shareable resource (docs/plans/multiplayer-sharing.md §3.4): whoever
 * makes one owns it, and a listing shows a member only the tasks they may open.
 */
export function registerTasksHandlers(server: SolusServer, deps: { shares?: ShareManager } = {}): void {
  startTaskSyncEngine()
  const claim = async (task: TaskRecord | null, ctx: HandlerCtx): Promise<void> => {
    if (task) await deps.shares?.claimOwner({ kind: 'task', id: task.id }, ctx.principal)
  }
  const visibleTasks = async (ctx: HandlerCtx, tasks: TaskRecord[]): Promise<TaskRecord[]> =>
    deps.shares ? deps.shares.filterVisible(ctx.principal, 'task', tasks, (task) => task.id) : tasks
  server.register('tasksProviderStatus', (args) => {
    const [cwd, opts] = args
    return taskProviderStatus(cwd, opts ?? {})
  })

  server.register('inboxListUpstream', (args, ctx) => {
    const [involvement] = args
    return listInboxUpstream(organizationOf(ctx.principal), involvement)
  })

  server.register('tasksListUpstream', (args, ctx) => {
    const [cwd, opts] = args
    return listUpstreamTasks(organizationOf(ctx.principal), cwd, opts ?? {})
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

  server.register('tasksListAssigneeCandidates', (args) => {
    const [cwd] = args
    return listTaskAssigneeCandidates(cwd)
  })

  server.register('tasksListCandidates', (args) => {
    const [cwd, options] = args
    return listTaskCandidates(cwd, options)
  })

  server.register('tasksImport', (args, ctx) => {
    const [cwd, externalIds] = args
    return importTaskTickets(organizationOf(ctx.principal), cwd, externalIds)
  })

  server.register('tasksPublish', (args, ctx) => {
    const [id, cwd] = args
    return publishTask(organizationOf(ctx.principal), id, cwd)
  })

  server.register('tasksSyncNow', (args, ctx) => {
    const [id] = args
    return syncTasksNow(organizationOf(ctx.principal), id)
  })

  server.register('tasksList', async (args, ctx) => {
    const [filter] = args
    const result = await listTasks(organizationOf(ctx.principal), filter)
    return { ...result, tasks: await visibleTasks(ctx, result.tasks) }
  })

  server.register('tasksSidebarSnapshot', async (_args, ctx) => {
    const snapshot = await readTaskSidebarSnapshot(organizationOf(ctx.principal))
    const tasks = await visibleTasks(ctx, snapshot.tasks)
    if (tasks.length === snapshot.tasks.length) return snapshot
    const visible = new Set(tasks.map((task) => task.id))
    const keep = <T>(byTask: Record<string, T> | undefined): Record<string, T> | undefined =>
      byTask && Object.fromEntries(Object.entries(byTask).filter(([taskId]) => visible.has(taskId)))
    const filtered: TaskSidebarSnapshot = { tasks, sessionsByTask: keep(snapshot.sessionsByTask) ?? {} }
    const prLinksByTask = keep(snapshot.prLinksByTask)
    if (prLinksByTask) filtered.prLinksByTask = prLinksByTask
    const prLinkListsByTask = keep(snapshot.prLinkListsByTask)
    if (prLinkListsByTask) filtered.prLinkListsByTask = prLinkListsByTask
    return filtered
  })

  server.register('tasksGet', async (args, ctx) => {
    const [id] = args
    const organizationId = organizationOf(ctx.principal)
    const details = await (await Task.byId(organizationId, id)).details()
    if (details.externalLink) pullTaskSoon(organizationId, id)
    return details
  })

  server.register('tasksCreate', async (args, ctx) => {
    const [input] = args
    const task = await createTask(organizationOf(ctx.principal), input)
    await claim(task, ctx)
    return task
  })

  server.register('tasksUpdate', async (args, ctx) => {
    const [id, patch] = args
    return (await (await Task.byId(organizationOf(ctx.principal), id)).update(patch)).record()
  })

  server.register('tasksMarkRead', (args, ctx) => {
    const [id, read] = args
    return markTaskRead(organizationOf(ctx.principal), id, read)
  })

  server.register('tasksRecordActivity', (args, ctx) => {
    const [id] = args
    return recordTaskActivity(organizationOf(ctx.principal), id)
  })

  server.register('tasksDelete', async (args, ctx) => {
    const [id] = args
    const organizationId = organizationOf(ctx.principal)
    const deleted = await (await Task.byId(organizationId, id)).delete()
    if (deleted) await deps.shares?.forget(organizationId, { kind: 'task', id })
    return deleted
  })

  server.register('tasksComment', async (args, ctx) => {
    const [id, body, options] = args
    return (await Task.byId(organizationOf(ctx.principal), id)).comment(body, options)
  })

  server.register('tasksDeleteComment', async (args, ctx) => {
    const [id, commentId] = args
    return (await Task.byId(organizationOf(ctx.principal), id)).deleteComment(commentId)
  })

  server.register('tasksPublishComments', async (args, ctx) => {
    const [id, commentIds] = args
    return (await Task.byId(organizationOf(ctx.principal), id)).publishComments(commentIds)
  })

  server.register('tasksLinkSession', async (args, ctx) => {
    const [taskId, sessionId, role, execution] = args
    return (await Task.byId(organizationOf(ctx.principal), taskId)).linkSession(sessionId, role ?? 'working', { execution })
  })

  server.register('tasksUnlinkSession', async (args, ctx) => {
    const [taskId, sessionId] = args
    return (await Task.byId(organizationOf(ctx.principal), taskId)).unlinkSession(sessionId)
  })

  /** A provider handoff happens on the execution host. For a dispatched run,
   * the task attempt belongs to another host, so the client forwards the stable
   * identity change here instead of leaving the old provider attempt behind. */
  server.register('tasksRekeySession', async (args, ctx) => {
    const [sourceSessionId, targetSessionId] = args
    await rekeyTaskSessionLinks(organizationOf(ctx.principal), sourceSessionId, targetSessionId)
  })

  server.register('tasksLink', async (args, ctx) => {
    const [taskId, input] = args
    return (await Task.byId(organizationOf(ctx.principal), taskId)).link(input)
  })

  server.register('tasksUnlink', async (args, ctx) => {
    const [taskId, kind, targetKey, targetScope] = args
    return (await Task.byId(organizationOf(ctx.principal), taskId)).unlink(kind, targetKey, targetScope ?? '')
  })

  server.register('tasksLinkedTo', (args, ctx) => {
    const [targets] = args
    return readTasksLinkingTargets(getDatabase(), organizationOf(ctx.principal), targets)
  })

  server.register('tasksAttachArtifact', (args, ctx) => {
    const [taskId, workId] = args
    return attachArtifactToTask(organizationOf(ctx.principal), taskId, workId)
  })

  server.register('tasksSessions', (args, ctx) => {
    const [taskId] = args
    return taskSessions(organizationOf(ctx.principal), taskId)
  })

  server.register('tasksForSession', (args, ctx) => {
    const [sessionId] = args
    return tasksForSession(organizationOf(ctx.principal), sessionId)
  })

  /**
   * The first-dispatch mint, addressed to the host that owns the project rather
   * than performed as a side effect on whichever host runs the agent. A
   * dispatched session runs elsewhere and files here, so only the client knows
   * both hosts and must name this one. The session link follows separately, once
   * the execution host has issued a session id.
   */
  server.register('tasksPrepareForSession', async (args, ctx) => {
    const [input] = args
    const organizationId = organizationOf(ctx.principal)
    const task = await prepareSessionTask(organizationId, input)
    await claim(task, ctx)
    // The snapshot rides the same round trip a dispatching client already makes
    // (docs/plans/dispatch-parity.md): the execution host cannot read this
    // host's store, so the client ships the state — including linked works and
    // plans in full — with the prompt.
    const snapshot = task && input.includeSnapshot
      ? await attachLinkedContent(organizationId, await taskSnapshot(organizationId, task.id))
      : null
    return { task, snapshot } satisfies PrepareSessionTaskResult
  })

  /** A dispatched session's follow-up prompts re-ship the packet, so the client
   *  re-reads the task's live state from this host before each send. */
  server.register('tasksSnapshot', async (args, ctx) => {
    const [taskId] = args
    const organizationId = organizationOf(ctx.principal)
    return attachLinkedContent(organizationId, await taskSnapshot(organizationId, taskId))
  })
}
