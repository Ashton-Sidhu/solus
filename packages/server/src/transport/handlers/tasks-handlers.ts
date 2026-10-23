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
import { prepareSessionTask, taskIdsForSessions, taskSessions, tasksForSession } from '../../data/tasks/task-sessions'
import { stopPullRequestWatch } from '../../data/sessions/pull-request-watches'
import { startSessionPullRequestWatch } from '../../prs/start-pull-request-watch'
import { markTaskRead, recordTaskActivity } from '../../data/tasks/task-lifecycle'
import { readTaskSnoozes, snoozeTaskFor } from '../../data/tasks/task-snoozes'
import { getDatabase } from '../../db/database'
import { readTaskSidebarSnapshot } from '../../data/tasks/task-sidebar'
import { recordTaskChange, taskListChangesSince, taskListRevision } from '../../data/tasks/task-revisions'
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
import { isHostAdmin, organizationForNew, recordScopeOf, type Principal } from '../../admission/principal'
import { attributionOf, ownerKeyOf, type Actor } from '../../admission/actor'
import type { ShareManager } from '../../sharing/share-manager'
import { listInboxUpstream } from '../../data/tasks/inbox'
import type { Task as TaskRecord, TaskSidebarSnapshot } from '@solus/contracts/task-types'
import { MAX_SIDEBAR_TASK_IDS } from '@solus/contracts/task-types'
import { createHash } from 'node:crypto'
import { createLogger, isDebugEnabled } from '../../logger'

const log = createLogger('main', 'tasks-handlers')
/** The most changed sessions a resume looks up; more, and it sends the whole list. */
const MAX_RESUMED_SESSION_IDS = 1000
const taskSidebarFilterSchema = z.object({
  taskIds: z.array(z.string()).max(MAX_SIDEBAR_TASK_IDS).optional(),
  since: z.string().max(200).optional(),
}).nullish()

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

/** Who reads the task list: two connections with one key see the same list.
 *  A grant's expiry is left out, because a socket dials again with a new grant
 *  and must still resume. */
function taskListReaderKey(principal: Principal): string {
  const identity = 'expiresAt' in principal ? { ...principal, expiresAt: 0 } : principal
  return createHash('sha256')
    .update(JSON.stringify([identity, recordScopeOf(principal)]))
    .digest('hex')
    .slice(0, 16)
}

export function registerTasksHandlers(server: SolusServer, deps: { shares?: ShareManager; sync?: boolean } = {}): void {
  if (deps.sync !== false) startTaskSyncEngine()
  const visibleTasks = async (ctx: HandlerCtx, tasks: TaskRecord[]): Promise<TaskRecord[]> =>
    deps.shares ? deps.shares.filterVisible(ctx.principal, 'task', tasks, (task) => task.id) : tasks
  /** The tasks changed after `revision`: the ones written, and the ones linked
   *  to a session whose title, branch, or activity changed. Null when the log
   *  cannot say, or when so many sessions changed that a whole read is cheaper. */
  const changedTasksSince = async (ctx: HandlerCtx, revision: string, readerKey: string): Promise<string[] | null> => {
    const changes = taskListChangesSince(revision, readerKey)
    if (!changes || changes.sessionIds.length > MAX_RESUMED_SESSION_IDS) return null
    const linked = await taskIdsForSessions(recordScopeOf(ctx.principal), changes.sessionIds)
    return [...new Set([...changes.taskIds, ...linked])]
  }
  /** The snapshot without the tasks this caller may not open. */
  const visibleSnapshot = async (ctx: HandlerCtx, snapshot: TaskSidebarSnapshot): Promise<TaskSidebarSnapshot> => {
    const tasks = await visibleTasks(ctx, snapshot.tasks)
    if (tasks.length === snapshot.tasks.length) return snapshot
    const visible = new Set(tasks.map((task) => task.id))
    const keep = <T>(byTask: Record<string, T> | undefined): Record<string, T> | undefined =>
      byTask && Object.fromEntries(Object.entries(byTask).filter(([taskId]) => visible.has(taskId)))
    const filtered: TaskSidebarSnapshot = { tasks, sessionsByTask: keep(snapshot.sessionsByTask) ?? {} }
    const prLinkListsByTask = keep(snapshot.prLinkListsByTask)
    if (prLinkListsByTask) filtered.prLinkListsByTask = prLinkListsByTask
    return filtered
  }
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

  server.register('tasksImport', async (args, ctx) => {
    const [cwd, externalIds] = args
    const imported = await importTaskTickets(organizationForNew(ctx.principal), cwd, externalIds, ownerKeyOf(ctx.actor) ?? undefined)
    // An imported ticket is the importer's task, shared with the organization in its space as any new task is.
    for (const { task } of imported) await deps.shares?.shareWithOrganization({ kind: 'task', id: task.id }, ctx.principal)
    return imported
  })

  server.register('tasksPublish', (args, ctx) => {
    const [id, cwd] = args
    return publishTask(recordScopeOf(ctx.principal), id, cwd)
  })

  server.register('tasksSyncNow', (args, ctx) => {
    const [id] = args
    return syncTasksNow(recordScopeOf(ctx.principal), id)
  })


  // A share decides who sees a task, so a resume names the task again.
  deps.shares?.onChanged((change) => {
    if (change.resource.kind === 'task') recordTaskChange(change.resource.id)
  })

  server.register('tasksSidebarSnapshot', async (args, ctx) => {
    const parsed = taskSidebarFilterSchema.safeParse(args[0])
    if (!parsed.success) throw new Error(`A sidebar read names at most ${MAX_SIDEBAR_TASK_IDS} task ids and one revision.`)
    const filter = parsed.data
    // A narrowed read covers only its rows, so it gives no revision. The
    // revision is read before the rows: a change that commits during the read
    // is then in the next resume (docs/plans/task-snapshot-resume.md).
    const readerKey = taskListReaderKey(ctx.principal)
    const revision = filter?.taskIds ? undefined : taskListRevision(readerKey)
    const changed = !filter?.taskIds && filter?.since ? await changedTasksSince(ctx, filter.since, readerKey) : null
    const changedTaskIds = changed && changed.length <= MAX_SIDEBAR_TASK_IDS ? changed : undefined
    if (changedTaskIds?.length === 0) return { tasks: [], sessionsByTask: {}, revision, changedTaskIds }
    const taskIds = filter?.taskIds ?? changedTaskIds
    const startedAt = performance.now()
    const snapshot = await readTaskSidebarSnapshot(recordScopeOf(ctx.principal), taskIds)
    // The whole list is large (1,000+ tasks is over 1 MB), so a client reads it
    // at boot, resumes it at reconnect, and names the changed tasks otherwise.
    // Debug builds record each read's cost so a regression to whole-list reads shows.
    if (isDebugEnabled()) {
      log.debug('tasks_sidebar_snapshot_read', {
        clientId: ctx.clientId,
        requestedTaskCount: taskIds?.length ?? null,
        resumed: changedTaskIds !== undefined,
        readMs: Math.round(performance.now() - startedAt),
        taskCount: snapshot.tasks.length,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      })
    }
    const answer = await visibleSnapshot(ctx, snapshot)
    if (revision) answer.revision = revision
    if (changedTaskIds) answer.changedTaskIds = changedTaskIds
    return answer
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

  // A session owns its pull request links; a task reads the links of its
  // sessions (docs/plans/session-pull-requests.md). The links themselves are
  // `/v1/sessions/:sessionId/pull-requests`; watching one is execution.
  server.register('sessionPullRequestWatch', async (args) => {
    const [sessionId, repository, number, watching] = args
    if (!watching) {
      await stopPullRequestWatch(sessionId, repository, number)
      return 'stopped'
    }
    return startSessionPullRequestWatch(sessionId, repository, number)
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
