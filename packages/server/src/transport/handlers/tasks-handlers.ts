import { z } from 'zod'
import type { PrepareSessionTaskResult } from '@solus/contracts/task-types'
import {
  commentOnUpstreamTask,
  getUpstreamTask,
  listTaskAssigneeCandidates,
  listUpstreamTasks,
  taskProviderStatus,
  updateUpstreamTask,
} from '../../data/tasks/upstream'
import { createTask } from '../../data/tasks/task-store'
import { Task, taskSnapshot } from '../../data/tasks/task'
import { readTasksLinkingTargets } from '../../data/tasks/task-links'
import { attachLinkedContent } from '../../data/tasks/linked-content'
import { attachArtifactToTask } from '../../data/tasks/task-artifacts'
import { prepareSessionTask, rekeyTaskSessionLinks, taskSessions, tasksForSession } from '../../data/tasks/task-sessions'
import {
  linkSessionPullRequest,
  readSessionPullRequests,
  rekeySessionPullRequests,
  sessionPullRequestOwnerId,
  unlinkSessionPullRequest,
} from '../../data/sessions/session-pull-requests'
import { readSessionShelf, rekeySessionState, settleSession, snoozeSession, unsettleSession } from '../../data/sessions/session-states'
import { markTaskRead, recordTaskActivity } from '../../data/tasks/task-lifecycle'
import { readTaskSnoozes, snoozeTaskFor } from '../../data/tasks/task-snoozes'
import { getDatabase } from '../../db/database'
import { readTaskSidebarSnapshot } from '../../data/tasks/task-sidebar'
import { searchTaskComments } from '../../data/tasks/comment-search'
import {
  importTaskTickets,
  listTaskCandidates,
  publishTask,
  pullTaskSoon,
  startTaskSyncEngine,
  syncTasksNow,
} from '../../data/tasks/sync-engine'
import type { HandlerCtx, SolusServer } from '../server'
import { isHostAdmin, organizationForNew, recordScopeOf } from '../../admission/principal'
import { attributionOf, ownerKeyOf, type Actor } from '../../admission/actor'
import type { ShareManager } from '../../sharing/share-manager'
import { listInboxUpstream } from '../../data/tasks/inbox'
import type { Task as TaskRecord, TaskSidebarSnapshot } from '@solus/contracts/task-types'
import { MAX_SIDEBAR_TASK_IDS } from '@solus/contracts/task-types'
import { createLogger, isDebugEnabled } from '../../logger'

const log = createLogger('main', 'tasks-handlers')
const taskOpenTimingSchema = z.object({
  activationId: z.string().max(100),
  taskId: z.string().max(200).nullable(),
  outcome: z.enum(['completed', 'cancelled', 'failed']),
  marks: z.array(z.object({ stage: z.string().max(64), elapsedMs: z.number().finite().nonnegative() })).max(32),
})

/**
 * Global native-task RPCs plus project-scoped upstream-provider reads/writes.
 * A task is a shareable resource (docs/plans/multiplayer-sharing.md §3.4): whoever
 * makes one owns it, and a listing shows a member only the tasks they may open.
 *
 * A read is scoped to what the caller may see (`recordScopeOf`); a task it
 * creates starts in the caller's organization (`organizationForNew`); a write to
 * an existing task lands in that task's own organization (organization-scope R10).
 */
/** The person a task snooze belongs to. The host itself and a runner are no
 *  person, so they cannot snooze. */
function personKeyFor(actor: Actor): string {
  const personKey = ownerKeyOf(actor)
  if (!personKey) throw new Error('A snooze belongs to a person, and this connection acts for none.')
  return personKey
}

export function registerTasksHandlers(server: SolusServer, deps: { shares?: ShareManager; sync?: boolean } = {}): void {
  if (deps.sync !== false) startTaskSyncEngine()
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
    return listInboxUpstream(recordScopeOf(ctx.principal), involvement)
  })

  server.register('tasksListUpstream', (args, ctx) => {
    const [cwd, opts] = args
    return listUpstreamTasks(recordScopeOf(ctx.principal), cwd, opts ?? {})
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
    return importTaskTickets(organizationForNew(ctx.principal), cwd, externalIds)
  })

  server.register('tasksPublish', (args, ctx) => {
    const [id, cwd] = args
    return publishTask(recordScopeOf(ctx.principal), id, cwd)
  })

  server.register('tasksSyncNow', (args, ctx) => {
    const [id] = args
    return syncTasksNow(recordScopeOf(ctx.principal), id)
  })


  server.register('tasksLogOpenTiming', ([input], ctx) => {
    const timing = taskOpenTimingSchema.parse(input)
    log.info('task_sidebar_open_timing', {
      clientId: ctx.clientId,
      activationId: timing.activationId,
      taskId: timing.taskId,
      outcome: timing.outcome,
      marks: timing.marks.map(({ stage, elapsedMs }) => ({ stage, elapsedMs })),
    })
  })

  server.register('tasksSidebarSnapshot', async (args, ctx) => {
    const [filter] = args
    const taskIds = filter?.taskIds
    if (taskIds && (!Array.isArray(taskIds) || taskIds.length > MAX_SIDEBAR_TASK_IDS || taskIds.some((taskId) => typeof taskId !== 'string'))) {
      throw new Error(`A sidebar read names at most ${MAX_SIDEBAR_TASK_IDS} task ids.`)
    }
    const startedAt = performance.now()
    const snapshot = await readTaskSidebarSnapshot(recordScopeOf(ctx.principal), taskIds)
    // The whole list is large (1,000+ tasks is over 1 MB), so a client reads it
    // at boot and reconnect and names the changed tasks otherwise. Debug builds
    // record each read's cost so a regression to whole-list reads shows.
    if (isDebugEnabled()) {
      log.debug('tasks_sidebar_snapshot_read', {
        clientId: ctx.clientId,
        requestedTaskCount: taskIds?.length ?? null,
        readMs: Math.round(performance.now() - startedAt),
        taskCount: snapshot.tasks.length,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      })
    }
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

  server.register('tasksSearchComments', (args, ctx) => {
    const [query] = args
    return searchTaskComments(recordScopeOf(ctx.principal), query)
  })

  server.register('tasksReadExtras', async (args, ctx) => {
    const [id] = args
    const scope = recordScopeOf(ctx.principal)
    const details = await (await Task.byId(scope, id)).details()
    if (details.externalLink) pullTaskSoon(scope, id)
    const { task: _task, ...extras } = details
    return extras
  })



  server.register('tasksMarkRead', (args, ctx) => {
    const [id, read] = args
    return markTaskRead(recordScopeOf(ctx.principal), id, read)
  })

  // A snooze is the caller's own: the person comes from the connection, never
  // from the request, so nobody can read or write another person's snoozes.
  server.register('tasksSnooze', (args, ctx) => {
    const [id, until, note] = args
    return snoozeTaskFor(recordScopeOf(ctx.principal), personKeyFor(ctx.actor), id, until, note)
  })

  server.register('tasksSnoozes', (_args, ctx) => {
    const personKey = ownerKeyOf(ctx.actor)
    return personKey ? readTaskSnoozes(recordScopeOf(ctx.principal), personKey) : Promise.resolve([])
  })

  server.register('tasksRecordActivity', (args, ctx) => {
    const [id] = args
    return recordTaskActivity(recordScopeOf(ctx.principal), id, attributionOf(ctx.actor))
  })


  server.register('tasksComment', async (args, ctx) => {
    const [id, body, options] = args
    return (await Task.byId(recordScopeOf(ctx.principal), id)).comment(body, { ...options, by: attributionOf(ctx.actor) })
  })

  server.register('tasksDeleteComment', async (args, ctx) => {
    const [id, commentId] = args
    // The access policy admits any editor; the task's owner or a host admin also moderates other people's comments.
    const canModerate = isHostAdmin(ctx.principal) || (await deps.shares?.roleFor(ctx.principal, { kind: 'task', id }) ?? 'owner') === 'owner'
    return (await Task.byId(recordScopeOf(ctx.principal), id)).deleteComment(commentId, { by: attributionOf(ctx.actor), canModerate })
  })

  server.register('tasksPublishComments', async (args, ctx) => {
    const [id, commentIds] = args
    return (await Task.byId(recordScopeOf(ctx.principal), id)).publishComments(commentIds)
  })

  server.register('tasksLinkSession', async (args, ctx) => {
    const [taskId, sessionId, role, execution] = args
    return (await Task.byId(recordScopeOf(ctx.principal), taskId)).linkSession(sessionId, role ?? 'working', { execution, startedBy: attributionOf(ctx.actor) })
  })

  server.register('tasksUnlinkSession', async (args, ctx) => {
    const [taskId, sessionId] = args
    return (await Task.byId(recordScopeOf(ctx.principal), taskId)).unlinkSession(sessionId, attributionOf(ctx.actor))
  })

  /** A provider handoff happens on the execution host. For a dispatched run,
   * the task attempt belongs to another host, so the client forwards the stable
   * identity change here instead of leaving the old provider attempt behind. */
  server.register('tasksRekeySession', async (args, ctx) => {
    const [sourceSessionId, targetSessionId] = args
    await rekeyTaskSessionLinks(recordScopeOf(ctx.principal), sourceSessionId, targetSessionId)
    await rekeySessionPullRequests(sourceSessionId, targetSessionId)
    await rekeySessionState(sourceSessionId, targetSessionId)
  })

  // A session owns its pull request links; a task reads the links of its
  // sessions (docs/plans/session-pull-requests.md).
  server.register('sessionPullRequestsList', async (args, ctx) => {
    const [sessionIds] = args
    const links = await readSessionPullRequests(
      recordScopeOf(ctx.principal),
      sessionIds?.map(sessionPullRequestOwnerId),
    )
    if (!deps.shares) return links
    const visible = await deps.shares.filterVisible(ctx.principal, 'session', Object.keys(links), (sessionId) => sessionId)
    return Object.fromEntries(visible.map((sessionId) => [sessionId, links[sessionId] ?? []]))
  })

  server.register('sessionPullRequestLink', async (args, ctx) => {
    const [sessionId, url] = args
    await linkSessionPullRequest(sessionId, { url, source: 'manual', by: attributionOf(ctx.actor) })
  })

  server.register('sessionPullRequestUnlink', async (args) => {
    const [sessionId, repository, number] = args
    await unlinkSessionPullRequest(sessionId, repository, number)
  })

  // Where a session is in a person's list: active, settled, or snoozed.
  server.register('sessionShelfList', async (args, ctx) => {
    const [sessionIds] = args
    const shelf = await readSessionShelf(recordScopeOf(ctx.principal), sessionIds)
    return deps.shares
      ? deps.shares.filterVisible(ctx.principal, 'session', shelf, (entry) => entry.sessionId)
      : shelf
  })

  server.register('sessionSetSettled', async (args) => {
    const [sessionId, settled] = args
    if (settled) await settleSession(sessionId, 'person')
    else await unsettleSession(sessionId)
  })

  server.register('sessionSnooze', async (args) => {
    const [sessionId, until, note] = args
    await snoozeSession(sessionId, until, note)
  })

  server.register('tasksLink', async (args, ctx) => {
    const [taskId, input] = args
    return (await Task.byId(recordScopeOf(ctx.principal), taskId)).link(input, attributionOf(ctx.actor))
  })

  server.register('tasksUnlink', async (args, ctx) => {
    const [taskId, kind, targetKey, targetScope] = args
    return (await Task.byId(recordScopeOf(ctx.principal), taskId)).unlink(kind, targetKey, targetScope ?? '', attributionOf(ctx.actor))
  })

  server.register('tasksLinkedTo', (args, ctx) => {
    const [targets] = args
    return readTasksLinkingTargets(getDatabase(), recordScopeOf(ctx.principal), targets)
  })

  server.register('tasksAttachArtifact', (args, ctx) => {
    const [taskId, workId] = args
    return attachArtifactToTask(recordScopeOf(ctx.principal), taskId, workId, attributionOf(ctx.actor))
  })

  server.register('tasksSessions', (args, ctx) => {
    const [taskId] = args
    return taskSessions(recordScopeOf(ctx.principal), taskId)
  })

  server.register('tasksForSession', (args, ctx) => {
    const [sessionId] = args
    return tasksForSession(recordScopeOf(ctx.principal), sessionId)
  })

  /**
   * The first-dispatch bind, addressed to the host that owns the task rather
   * than performed as a side effect on whichever host runs the agent. A
   * dispatched session runs elsewhere and files here, so only the client knows
   * both hosts and must name this one. The session link follows separately, once
   * the execution host has issued a session id.
   */
  server.register('tasksPrepareForSession', async (args, ctx) => {
    const [input] = args
    const scope = recordScopeOf(ctx.principal)
    const task = await prepareSessionTask(scope, input)
    await claim(task, ctx)
    // The snapshot rides the same round trip a dispatching client already makes
    // (docs/plans/dispatch-parity.md): the execution host cannot read this
    // host's store, so the client ships the state — including linked works and
    // plans in full — with the prompt.
    const snapshot = task && input.includeSnapshot
      ? await attachLinkedContent(await taskSnapshot(scope, task.id))
      : null
    return { task, snapshot } satisfies PrepareSessionTaskResult
  })

  /** A dispatched session's follow-up prompts re-ship the packet, so the client
   *  re-reads the task's live state from this host before each send. */
  server.register('tasksSnapshot', async (args, ctx) => {
    const [taskId] = args
    return attachLinkedContent(await taskSnapshot(recordScopeOf(ctx.principal), taskId))
  })
}
