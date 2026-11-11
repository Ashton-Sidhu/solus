import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { PrepareSessionTaskResult } from '@solus/contracts/task-types'
import { MAX_SIDEBAR_TASK_IDS } from '@solus/contracts/task-types'
import {
  commentOnTask,
  createTask,
  deleteTask,
  deleteTaskComment,
  getTask,
  listTaskAssignees,
  markTaskRead,
  moveTask,
  retryTaskComment,
  searchTasks,
  taskSnapshot,
  updateTask,
} from '../../data/tasks/task'
import { linkTask, linkTaskSession, taskAttachments, unlinkTask, unlinkTaskSession } from '../../data/tasks/task-attachments'
import { readTasksLinkingTargets } from '../../data/tasks/task-links'
import { attachLinkedContent } from '../../data/tasks/linked-content'
import { attachArtifactToTask } from '../../data/tasks/task-artifacts'
import { prepareSessionTask } from '../../data/tasks/session-task'
import { taskIdsForSessions, taskSessions, tasksForSession } from '../../data/tasks/task-sessions'
import { stopPullRequestWatch } from '../../data/sessions/pull-request-watches'
import { readSessionArtifacts } from '../../data/sessions/session-artifacts'
import { organizationOfSession } from '../../data/sessions/session-records'
import { startSessionPullRequestWatch } from '../../prs/start-pull-request-watch'
import { readTaskSnoozes, snoozeTaskFor } from '../../data/tasks/task-snoozes'
import { getDatabase } from '../../db/database'
import { readTaskSidebarSnapshot } from '../../data/tasks/task-sidebar'
import { taskListChangesSince, taskListRevision } from '../../data/tasks/task-revisions'
import { searchTaskComments } from '../../data/tasks/comment-search'
import { taskSourceOptions } from '../../data/tasks/source-options'
import { startTaskSourcePolling, tasksSources } from '../../data/tasks/task-sources'
import type { TaskReader } from '../../data/tasks/task-store'
import type { HandlerCtx, SolusServer } from '../server'
import { organizationForNew, recordScopeOf, type Principal } from '../../admission/principal'
import { attributionOf, ownerKeyOf, type Actor } from '../../admission/actor'
import { hostUserKey } from '../../host/host-user'
import { createLogger, isDebugEnabled } from '../../logger'

const log = createLogger('main', 'tasks-handlers')
/** The most changed sessions a resume looks up; more, and it sends the whole list. */
const MAX_RESUMED_SESSION_IDS = 1000
const taskSidebarFilterSchema = z.object({
  taskIds: z.array(z.string()).max(MAX_SIDEBAR_TASK_IDS).optional(),
  since: z.string().max(200).optional(),
}).nullish()

/**
 * The task RPCs (docs/plans/provider-owned-tasks.md §5). GitHub and Jira own
 * every task, so a task is not a Solus resource: who can read or change one is
 * decided by the caller's own provider connection, which each provider call
 * uses. The attachments of a task are records: a read names the scope the
 * caller may see (`recordScopeOf`), and a new one is made in the caller's
 * organization (`organizationForNew`), or in the session's for a session link.
 */

/** The person a task snooze belongs to. The host itself and a runner are no
 *  person, so they cannot snooze. */
function personKeyFor(actor: Actor): string {
  const personKey = ownerKeyOf(actor)
  if (!personKey) throw new Error('A snooze belongs to a person, and this connection acts for none.')
  return personKey
}

/** Whose provider connections decide which task sources the caller sees. The
 *  host's own work reads as the host's user. */
function readerOf(ctx: HandlerCtx): TaskReader {
  return { personKey: ownerKeyOf(ctx.actor) ?? hostUserKey(), scope: recordScopeOf(ctx.principal) }
}

/** Who reads the task list: two connections with one key see the same list.
 *  A grant's expiry is left out, because a socket dials again with a new grant
 *  and must still resume. */
function taskListReaderKey(principal: Principal, personKey: string): string {
  const identity = 'expiresAt' in principal ? { ...principal, expiresAt: 0 } : principal
  return createHash('sha256')
    .update(JSON.stringify([identity, recordScopeOf(principal), personKey]))
    .digest('hex')
    .slice(0, 16)
}

/**
 * `attachmentsOnly` is a host that holds the attachments of tasks and reads no
 * task from a provider: the organization's Solus API. It serves the
 * collaboration-plane methods alone (`rpc-planes.ts`), has no task copies, and
 * starts no source timer.
 */
export function registerTasksHandlers(server: SolusServer, deps: { attachmentsOnly?: boolean } = {}): void {
  registerAttachmentHandlers(server, deps.attachmentsOnly === true)
  if (deps.attachmentsOnly) return
  startTaskSourcePolling()

  server.register('tasksSources', (args, ctx) => {
    const [cwds, opts] = args
    return tasksSources(cwds, readerOf(ctx).personKey, { refresh: opts?.refresh })
  })

  server.register('tasksSourceOptions', (args) => {
    const [cwd] = args
    return taskSourceOptions(cwd)
  })

  server.register('tasksSearch', (args) => {
    const [cwd, query] = args
    return searchTasks(cwd, query)
  })

  server.register('tasksGet', (args, ctx) => {
    const [id] = args
    return getTask(recordScopeOf(ctx.principal), id, readerOf(ctx).personKey)
  })

  server.register('tasksCreate', (args, ctx) => {
    const [input] = args
    return createTask(input, readerOf(ctx).personKey)
  })

  server.register('tasksUpdate', (args) => {
    const [id, patch] = args
    return updateTask(id, patch)
  })

  server.register('tasksMove', (args) => {
    const [id, target] = args
    return moveTask(id, target)
  })

  server.register('tasksDelete', (args) => {
    const [id] = args
    return deleteTask(id)
  })

  server.register('tasksMarkRead', (args) => {
    const [id, read] = args
    return markTaskRead(id, read)
  })

  server.register('tasksComment', (args, ctx) => {
    const [id, body] = args
    return commentOnTask(recordScopeOf(ctx.principal), id, { body, by: attributionOf(ctx.actor) })
  })

  server.register('tasksRetryComment', (args, ctx) => {
    const [id, commentId] = args
    return retryTaskComment(recordScopeOf(ctx.principal), id, commentId)
  })

  server.register('tasksDeleteComment', (args, ctx) => {
    const [id, commentId] = args
    return deleteTaskComment(recordScopeOf(ctx.principal), id, commentId)
  })

  server.register('tasksListAssigneeCandidates', (args) => {
    const [target] = args
    return listTaskAssignees(target)
  })

  server.register('tasksAttachArtifact', (args, ctx) => {
    const [taskId, workId] = args
    return attachArtifactToTask(recordScopeOf(ctx.principal), taskId, workId, attributionOf(ctx.actor))
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
}

/** The collaboration-plane task methods: the list read and the attachments. */
function registerAttachmentHandlers(server: SolusServer, attachmentsOnly: boolean): void {
  /** The tasks changed after `revision`: the ones written, and the ones linked
   *  to a session whose title, branch, or activity changed. Null when the log
   *  cannot say, or when so many sessions changed that a whole read is cheaper. */
  const changedTasksSince = async (ctx: HandlerCtx, revision: string, readerKey: string): Promise<string[] | null> => {
    const changes = taskListChangesSince(revision, readerKey)
    if (!changes || changes.sessionIds.length > MAX_RESUMED_SESSION_IDS) return null
    const linked = await taskIdsForSessions(recordScopeOf(ctx.principal), changes.sessionIds)
    return [...new Set([...changes.taskIds, ...linked])]
  }

  server.register('tasksSidebarSnapshot', async (args, ctx) => {
    const parsed = taskSidebarFilterSchema.safeParse(args[0])
    if (!parsed.success) throw new Error(`A sidebar read names at most ${MAX_SIDEBAR_TASK_IDS} task ids and one revision.`)
    const filter = parsed.data
    const reader = readerOf(ctx)
    // A narrowed read covers only its rows, so it gives no revision. The
    // revision is read before the rows: a change that commits during the read
    // is then in the next resume (docs/plans/task-snapshot-resume.md).
    const readerKey = taskListReaderKey(ctx.principal, reader.personKey)
    const revision = filter?.taskIds ? undefined : taskListRevision(readerKey)
    const changed = !filter?.taskIds && filter?.since ? await changedTasksSince(ctx, filter.since, readerKey) : null
    const changedTaskIds = changed && changed.length <= MAX_SIDEBAR_TASK_IDS ? changed : undefined
    if (changedTaskIds?.length === 0) return { tasks: [], sessionsByTask: {}, revision, changedTaskIds }
    const taskIds = filter?.taskIds ?? changedTaskIds
    const startedAt = performance.now()
    const snapshot = await readTaskSidebarSnapshot(reader, taskIds)
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
    if (revision) snapshot.revision = revision
    if (changedTaskIds) snapshot.changedTaskIds = changedTaskIds
    return snapshot
  })

  server.register('tasksSearchComments', (args, ctx) => {
    const [query] = args
    return searchTaskComments(readerOf(ctx), query)
  })

  server.register('tasksAttachments', (args, ctx) => {
    const [id] = args
    return taskAttachments(recordScopeOf(ctx.principal), id)
  })

  // A snooze is the caller's own: the person comes from the connection, never
  // from the request, so nobody can read or write another person's snoozes.
  server.register('tasksSnooze', (args, ctx) => {
    const [id, until, note] = args
    return snoozeTaskFor(organizationForNew(ctx.principal), personKeyFor(ctx.actor), id, until, note)
  })

  server.register('tasksSnoozes', (_args, ctx) => {
    const personKey = ownerKeyOf(ctx.actor)
    return personKey ? readTaskSnoozes(recordScopeOf(ctx.principal), personKey) : Promise.resolve([])
  })

  server.register('tasksLinkSession', (args, ctx) => {
    const [taskId, sessionId, role, execution] = args
    return linkTaskSession(organizationForNew(ctx.principal), taskId, sessionId, role ?? 'working', { execution, startedBy: attributionOf(ctx.actor) })
  })

  server.register('tasksUnlinkSession', (args, ctx) => {
    const [taskId, sessionId] = args
    return unlinkTaskSession(recordScopeOf(ctx.principal), taskId, sessionId, attributionOf(ctx.actor))
  })

  // What a session produced or linked (docs/plans/session-artifacts.md). The
  // access policy admits the reader to the session; the list is read in the
  // session's own organization, where its links and works are.
  server.register('sessionArtifactsList', async (args) => {
    const [sessionId] = args
    return readSessionArtifacts(await organizationOfSession(sessionId), sessionId)
  })

  server.register('tasksLink', async (args, ctx) => {
    const [taskId, input] = args
    await linkTask(organizationForNew(ctx.principal), taskId, input, attributionOf(ctx.actor))
    return taskAttachments(recordScopeOf(ctx.principal), taskId)
  })

  server.register('tasksUnlink', async (args, ctx) => {
    const [taskId, kind, targetKey, targetScope] = args
    const scope = recordScopeOf(ctx.principal)
    await unlinkTask(scope, taskId, kind, targetKey, targetScope ?? '', attributionOf(ctx.actor))
    return taskAttachments(scope, taskId)
  })

  server.register('tasksLinkedTo', (args, ctx) => {
    const [targets] = args
    return readTasksLinkingTargets(getDatabase(), recordScopeOf(ctx.principal), targets)
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
   * The first-dispatch bind, addressed to the host that holds the task's
   * attachments rather than performed as a side effect on whichever host runs
   * the agent. A dispatched session runs elsewhere and files here, so only the
   * client knows both hosts and must name this one. The session link follows
   * separately, once the execution host has issued a session id.
   */
  server.register('tasksPrepareForSession', async (args, ctx) => {
    const [input] = args
    const scope = recordScopeOf(ctx.principal)
    // A host that reads no provider has no task to answer and none to move:
    // the link follows with `tasksLinkSession`, which needs no copy.
    if (attachmentsOnly) return { task: null, snapshot: null } satisfies PrepareSessionTaskResult
    const task = await prepareSessionTask(organizationForNew(ctx.principal), input)
    // The snapshot rides the same round trip a dispatching client already makes
    // (docs/plans/dispatch-parity.md): the execution host cannot read this
    // host's store, so the client ships the state — including linked works and
    // plans in full — with the prompt.
    const snapshot = task && input.includeSnapshot
      ? await attachLinkedContent(scope, await taskSnapshot(scope, task.id))
      : null
    return { task, snapshot } satisfies PrepareSessionTaskResult
  })

  /** A dispatched session's follow-up prompts re-ship the packet, so the client
   *  re-reads the task's live state from this host before each send. */
  server.register('tasksSnapshot', async (args, ctx) => {
    const [taskId] = args
    if (attachmentsOnly) throw new Error('This host holds the links of the task, not the task. Read it from the host that has its project.')
    const scope = recordScopeOf(ctx.principal)
    return attachLinkedContent(scope, await taskSnapshot(scope, taskId))
  })
}
