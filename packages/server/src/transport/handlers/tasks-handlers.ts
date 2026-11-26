import { taskReadOptionsSchema } from '@solus/contracts/task-read'
import { inspectTask, reactToTask, taskTemplates, resolveTaskUrl } from '../../data/tasks/task-inspection'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { IssueSourceState, PrepareSessionIssueResult } from '@solus/contracts/task-types'
import { MAX_SIDEBAR_ISSUE_IDS } from '@solus/contracts/task-types'
import { MAX_ISSUE_SOURCES, issueSourceKey, issueSourceSchema } from '@solus/contracts/task-sources'
import { permissionsAllow } from '@solus/contracts/permissions'
import { permissionsFor } from '../../admission/access-policy'
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
  taskDetails,
  taskSnapshot,
  updateTask,
} from '../../data/tasks/task'
import { linkTask, linkTaskSession, taskAttachments, unlinkTask, unlinkTaskSession } from '../../data/tasks/task-attachments'
import { readTasksLinkingTargets } from '../../data/tasks/task-links'
import { attachLinkedContent } from '../../data/tasks/linked-content'
import { attachArtifactToTask } from '../../data/tasks/task-artifacts'
import { prepareSessionTask } from '../../data/tasks/session-task'
import { taskIdsForSessions, issuesForSession } from '../../data/tasks/task-sessions'
import { stopPullRequestWatch } from '../../data/sessions/pull-request-watches'
import { readSessionArtifacts } from '../../data/sessions/session-artifacts'
import { organizationOfSession } from '../../data/sessions/session-records'
import { startSessionPullRequestWatch } from '../../prs/start-pull-request-watch'
import { getDatabase } from '../../db/database'
import { readTaskSidebarSnapshot } from '../../data/tasks/task-sidebar'
import { taskListChangesSince, taskListRevision } from '../../data/tasks/task-revisions'
import { searchTaskComments } from '../../data/tasks/comment-search'
import { defaultTaskSourceOptionsDeps, taskSourceOptions } from '../../data/tasks/source-options'
import { listProjects } from '../../project-config/projects-manifest'
import { isForkCheckout, resolveRepositoryKey } from '../../git/git-helpers'
import { projectsVisibleTo } from './setup-handlers'
import { loadMoreTaskSource, startTaskSourcePolling, issuesSources } from '../../data/tasks/task-sources'
import type { TaskReader } from '../../data/tasks/task-store'
import type { HandlerCtx, SolusServer } from '../server'
import { organizationForNew, recordScopeOf, type Principal } from '../../admission/principal'
import { attributionOf, ownerKeyOf } from '../../admission/actor'
import { hostUserKey } from '../../host/host-user'
import { createLogger, isDebugEnabled } from '../../logger'

const log = createLogger('main', 'tasks-handlers')

/** How many recent projects name the GitHub repositories the source menu lists first. */
const RECENT_PROJECTS_FOR_SOURCES = 8
/** The most changed sessions a resume looks up; more, and it sends the whole list. */
const MAX_RESUMED_SESSION_IDS = 1000
/** The task sources a client sends from the person's settings: the host reads each one with a provider. */
const taskSourcesSchema = z.array(issueSourceSchema).max(MAX_ISSUE_SOURCES)
const issueListRequestSchema = z.object({
  sources: taskSourcesSchema.optional(),
  refresh: z.enum(['stale', 'force']).optional(),
  loadMore: z.string().max(1024).optional(),
  issueIds: z.array(z.string()).max(MAX_SIDEBAR_ISSUE_IDS).optional(),
  since: z.string().max(200).optional(),
}).nullish()
const taskMoveTargetSchema = z.union([
  z.strictObject({ sourceKey: z.string().min(1), columnId: z.string().min(1) }),
  z.strictObject({ category: z.enum(['open', 'active', 'done']) }),
  z.strictObject({ statusId: z.string().min(1).max(512) }),
])

/**
 * The task RPCs (docs/plans/provider-owned-tasks.md §5). GitHub and Jira own
 * every task, so a task is not a Solus resource: who can read or change one is
 * decided by the caller's own provider connection, which each provider call
 * uses. The attachments of a task are records: a read names the scope the
 * caller may see (`recordScopeOf`), and a new one is made in the caller's
 * organization (`organizationForNew`), or in the session's for a session link.
 */

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

  // The caller's own projects lead the GitHub choices: a member sees only theirs.
  server.register('issuesSourceOptions', (_args, ctx) => taskSourceOptions({
    ...defaultTaskSourceOptionsDeps,
    projectRepositories: async () => {
      const recent = projectsVisibleTo(ctx.principal, await listProjects())
        .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
        .slice(0, RECENT_PROJECTS_FOR_SOURCES)
      const read = await Promise.all(recent.map(async (project) => {
        const repositoryKey = await resolveRepositoryKey(project.path)
        return repositoryKey ? [{ repositoryKey, isFork: await isForkCheckout(project.path) }] : []
      }))
      return read.flat()
    },
  }))
  server.register('issuesReact', ([id, targetId, content, add]) => reactToTask(id, targetId, content, add))
  server.register('issuesTemplates', ([source]) => taskTemplates(issueSourceSchema.parse(source)))
  server.register('issuesResolve', ([url, options], ctx) =>
    resolveTaskUrl(recordScopeOf(ctx.principal), url, readerOf(ctx).personKey, options?.detailsOnly === true))

  server.register('issuesSearch', (args) => {
    const [sources, query, involvement] = args
    return searchTasks(taskSourcesSchema.parse(sources), query, z.enum(['all', 'authored', 'assigned', 'mentioned']).default('all').parse(involvement))
  })

  server.register('issuesGet', (args, ctx) => {
    const [id, options] = args
    const read = taskReadOptionsSchema.parse(options ?? { section: 'details' })
    const taskId = z.string().min(1).max(512).parse(id)
    if (read.section === 'provider') return inspectTask(taskId, read.cursor, read.timelineOnly)
    if (read.cached) return taskDetails(recordScopeOf(ctx.principal), taskId)
    return getTask(recordScopeOf(ctx.principal), taskId, readerOf(ctx).personKey, { providerMetadata: true })
  })

  server.register('issuesCreate', (args, ctx) => {
    const [input] = args
    return createTask({ ...input, source: issueSourceSchema.parse(input.source) }, readerOf(ctx).personKey)
  })

  server.register('issuesUpdate', (args) => {
    const [id, patch] = args
    return updateTask(id, patch)
  })

  server.register('issuesMove', (args) => {
    const [id, target] = args
    return moveTask(id, taskMoveTargetSchema.parse(target))
  })

  server.register('issuesDelete', (args) => {
    const [id] = args
    return deleteTask(id)
  })

  server.register('issuesMarkRead', (args) => {
    const [id, read] = args
    return markTaskRead(id, read)
  })

  server.register('issuesComment', (args, ctx) => {
    const [id, body] = args
    return commentOnTask(recordScopeOf(ctx.principal), id, { body, by: attributionOf(ctx.actor) })
  })

  server.register('issuesRetryComment', (args, ctx) => {
    const [id, commentId] = args
    return retryTaskComment(recordScopeOf(ctx.principal), id, commentId)
  })

  server.register('issuesDeleteComment', (args, ctx) => {
    const [id, commentId] = args
    return deleteTaskComment(recordScopeOf(ctx.principal), id, commentId)
  })

  server.register('issuesListAssigneeCandidates', (args) => {
    const [target] = args
    return listTaskAssignees('issueId' in target ? target : { source: issueSourceSchema.parse(target.source) })
  })

  server.register('issuesAttachArtifact', (args, ctx) => {
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

  // The issue list. With the person's sources it also reads and answers their
  // state, which needs a person who may use the host (a link guest reads rows only).
  server.register('issuesList', async (args, ctx) => {
    const parsed = issueListRequestSchema.safeParse(args[0])
    if (!parsed.success) throw new Error(`An issue list read names at most ${MAX_ISSUE_SOURCES} sources, ${MAX_SIDEBAR_ISSUE_IDS} issue ids and one revision.`)
    const filter = parsed.data
    const reader = readerOf(ctx)
    let sources: IssueSourceState[] | undefined
    if (filter?.sources) {
      // The organization's Solus API holds attachments only: it reads no provider.
      if (attachmentsOnly) throw new Error('This host reads no issue sources.')
      if (!permissionsAllow(permissionsFor(ctx.principal), 'host.use')) throw new Error('Reading issue sources needs a person who may use this host.')
      if (filter.loadMore) {
        const source = filter.sources.find((candidate) => issueSourceKey(candidate) === filter.loadMore)
        if (!source) throw new Error('loadMore names a source that the request does not list.')
        await loadMoreTaskSource(source, reader.personKey)
      }
      sources = await issuesSources(filter.sources, reader.personKey, { refresh: filter.refresh })
    }
    if (filter?.issueIds?.length === 0) return { tasks: [], sessionsByTask: {}, ...(sources && { sources }) }
    // A narrowed read covers only its rows, so it gives no revision. The
    // revision is read before the rows: a change that commits during the read
    // is then in the next resume (docs/plans/task-snapshot-resume.md).
    const readerKey = taskListReaderKey(ctx.principal, reader.personKey)
    const revision = filter?.issueIds ? undefined : taskListRevision(readerKey)
    const changed = !filter?.issueIds && filter?.since ? await changedTasksSince(ctx, filter.since, readerKey) : null
    const changedTaskIds = changed && changed.length <= MAX_SIDEBAR_ISSUE_IDS ? changed : undefined
    if (changedTaskIds?.length === 0) return { tasks: [], sessionsByTask: {}, revision, changedTaskIds, ...(sources && { sources }) }
    const taskIds = filter?.issueIds ?? changedTaskIds
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
    if (sources) snapshot.sources = sources
    return snapshot
  })

  server.register('issuesSearchComments', (args, ctx) => {
    const [query] = args
    return searchTaskComments(readerOf(ctx), query)
  })

  server.register('issuesAttachments', (args, ctx) => {
    const [id] = args
    return taskAttachments(recordScopeOf(ctx.principal), id)
  })

  server.register('issuesLinkSession', (args, ctx) => {
    const [taskId, sessionId, role, execution] = args
    return linkTaskSession(organizationForNew(ctx.principal), taskId, sessionId, role ?? 'working', { execution, startedBy: attributionOf(ctx.actor) })
  })

  server.register('issuesUnlinkSession', (args, ctx) => {
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

  server.register('issuesLink', async (args, ctx) => {
    const [taskId, input] = args
    await linkTask(organizationForNew(ctx.principal), taskId, input, attributionOf(ctx.actor))
    return taskAttachments(recordScopeOf(ctx.principal), taskId)
  })

  server.register('issuesUnlink', async (args, ctx) => {
    const [taskId, kind, targetKey, targetScope] = args
    const scope = recordScopeOf(ctx.principal)
    await unlinkTask(scope, taskId, kind, targetKey, targetScope ?? '', attributionOf(ctx.actor))
    return taskAttachments(scope, taskId)
  })

  server.register('issuesLinkedTo', (args, ctx) => {
    const [targets] = args
    return readTasksLinkingTargets(getDatabase(), recordScopeOf(ctx.principal), targets)
  })

  server.register('issuesForSession', (args, ctx) => {
    const [sessionId] = args
    return issuesForSession(recordScopeOf(ctx.principal), sessionId)
  })

  /**
   * The first-dispatch bind, addressed to the host that holds the task's
   * attachments rather than performed as a side effect on whichever host runs
   * the agent. A dispatched session runs elsewhere and files here, so only the
   * client knows both hosts and must name this one. The session link follows
   * separately, once the execution host has issued a session id.
   */
  server.register('issuesPrepareForSession', async (args, ctx) => {
    const [input] = args
    const scope = recordScopeOf(ctx.principal)
    // A host that reads no provider has no task to answer and none to move:
    // the link follows with `issuesLinkSession`, which needs no copy.
    if (attachmentsOnly) return { task: null, snapshot: null } satisfies PrepareSessionIssueResult
    const task = await prepareSessionTask(organizationForNew(ctx.principal), input)
    // The snapshot rides the same round trip a dispatching client already makes
    // (docs/plans/dispatch-parity.md): the execution host cannot read this
    // host's store, so the client ships the state — including linked works and
    // plans in full — with the prompt.
    const snapshot = task && input.includeSnapshot
      ? await attachLinkedContent(scope, await taskSnapshot(scope, task.id))
      : null
    return { task, snapshot } satisfies PrepareSessionIssueResult
  })

  /** A dispatched session's follow-up prompts re-ship the packet, so the client
   *  re-reads the task's live state from this host before each send. */
  server.register('issuesSnapshot', async (args, ctx) => {
    const [taskId] = args
    if (attachmentsOnly) throw new Error('This host holds the links of the task, not the task. Read it from the host that has its project.')
    const scope = recordScopeOf(ctx.principal)
    return attachLinkedContent(scope, await taskSnapshot(scope, taskId))
  })
}
