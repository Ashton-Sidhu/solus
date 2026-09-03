import { connectedSite } from '../atlassian/api'
import { createLogger } from '../logger'
import { getDb } from '../db'
import { loadProjectConfig, resolveProjectKey } from '../project-config/project-config'
import { linkedExternalIds } from './task-sync-store'
import { resolveRepoRef } from '../git/git-helpers'
import { GitHubAuth } from '../providers/github/auth'
import { githubCredentialChain } from '../providers/github/credentials'
import { GitHubReauthRequiredError } from '../providers/github/octokit'
import type { RepoRef } from '@solus/contracts/providers'
import type { InboxInvolvement } from '@solus/contracts/inbox-types'
import {
  TASKS_AUTH_ERROR_PREFIX,
  type ExternalTicketRef,
  type NormalizedTicket,
  type Task,
  type TaskAssigneeCandidate,
  type TaskListResult,
  type TaskProviderStatus,
  type TaskSyncField,
  type TicketPatch,
  type TaskUpdatePatch,
} from '@solus/contracts/task-types'
import { resolveTaskPublishTarget, taskSyncAdapter, type TaskPublishTarget } from './adapters/registry'
import { z } from 'zod'

const log = createLogger('main', 'tasks-upstream')

interface UpstreamTaskCacheRow {
  fetched_at: number
  truncated: number | null
  tasks: string
}

const upstreamTaskCacheRowSchema = z.object({
  fetched_at: z.number(),
  truncated: z.number().nullable(),
  tasks: z.string(),
})

const CACHE_SCOPE = 'all'
const TASK_SYNC_FIELDS: readonly string[] = ['title', 'body', 'status', 'labels', 'priority', 'assignee']

function isTaskSyncField(field: string): field is TaskSyncField {
  return TASK_SYNC_FIELDS.includes(field)
}

function readUpstreamCache(
  projectKey: string,
  provider: string,
  externalKey: string,
  cacheScope = CACHE_SCOPE,
): { tasks: Task[]; fetchedAt: number; truncated?: boolean } | null {
  const parsedRow = upstreamTaskCacheRowSchema.safeParse(getDb().prepare(`
    SELECT fetched_at, truncated, tasks
    FROM upstream_task_cache
    WHERE project_key = ? AND provider = ? AND external_key = ? AND scope = ?
  `).get(projectKey, provider, externalKey, cacheScope))
  if (!parsedRow.success) return null
  const row: UpstreamTaskCacheRow = parsedRow.data
  try {
    // SAFETY: This cache is written only by writeUpstreamCache from typed Task values.
    const tasks = JSON.parse(row.tasks) as Task[]
    return {
      tasks,
      fetchedAt: row.fetched_at,
      truncated: row.truncated === null ? undefined : row.truncated === 1,
    }
  } catch (error) {
    log.error('upstream_task_cache_read_failed', {
      projectKey,
      provider,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function writeUpstreamCache(
  projectKey: string,
  provider: string,
  externalKey: string,
  result: { tasks: Task[]; truncated?: boolean },
  fetchedAt: number,
  cacheScope = CACHE_SCOPE,
): void {
  getDb().prepare(`
    INSERT INTO upstream_task_cache(project_key, provider, external_key, scope, fetched_at, truncated, tasks)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_key, provider, external_key, scope) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      truncated = excluded.truncated,
      tasks = excluded.tasks
  `).run(
    projectKey,
    provider,
    externalKey,
    cacheScope,
    fetchedAt,
    result.truncated === undefined ? null : result.truncated ? 1 : 0,
    JSON.stringify(result.tasks),
  )
}

function withProjectKey(task: Task, projectKey: string): Task {
  return { ...task, projectKey }
}

/**
 * Drop the tickets a native task already mirrors.
 *
 * Publishing or importing an issue makes a Solus task its owner and records the
 * link; the issue is then the same piece of work as that task, not a second one
 * beside it. Without this, publishing a task made it appear twice — once as the
 * task that owns the ticket and once as the ticket itself.
 *
 * Applied on the way out rather than before caching, so the cache stays a
 * faithful snapshot of the provider and linking a ticket later hides it without
 * needing another fetch.
 */
function withoutMirroredTickets(tasks: Task[], target: TaskPublishTarget): Task[] {
  const mirrored = linkedExternalIds(target.adapter.id, target.ref.externalKey)
  return mirrored.size ? tasks.filter((task) => !mirrored.has(task.id)) : tasks
}

function refFor(target: TaskPublishTarget, externalId: string, url: string): ExternalTicketRef {
  return { ...target.ref, externalId, url }
}

function taskFromTicket(ticket: NormalizedTicket, projectKey: string): Task {
  return {
    id: ticket.externalId,
    providerId: ticket.provider,
    projectKey,
    kind: 'task',
    title: ticket.title,
    body: ticket.body,
    status: ticket.status,
    url: ticket.url,
    labels: ticket.labels,
    assignee: ticket.assignee,
    assigneeAvatarUrl: ticket.assigneeAvatarUrl,
    priority: ticket.priorityHint,
    updatedAt: Date.parse(ticket.externalUpdatedAt),
    // Comments only. The renderer parses these to build a provider-owned
    // ticket's activity feed; the provider snapshot beside them was a second
    // full copy of the issue that no surface has ever read.
    raw: {
      comments: ticket.comments.map((comment) => ({
        id: comment.externalId,
        author: comment.author ? { login: comment.author } : null,
        body: comment.body,
        createdAt: new Date(comment.createdAt).toISOString(),
      })),
    },
  }
}

/** Read the configured upstream alongside native Solus tasks. Local remains the
 * durable source for Solus-owned work; these rows retain provider ownership. */
export async function listUpstreamTasks(
  cwd: string,
  opts: { involvement?: InboxInvolvement; query?: string } | null = {},
): Promise<TaskListResult> {
  const target = await resolveTaskPublishTarget(cwd)
  if (!target) return { tasks: [] }
  const projectKey = resolveProjectKey(cwd)
  const query = opts?.query?.trim()
  const cacheScope = opts?.involvement ?? CACHE_SCOPE
  // A search is never cached, in either direction: its result is not the
  // project's list, and the offline snapshot the page falls back to must stay
  // the complete one. A failed search reports the failure instead.
  const cached = query
    ? null
    : readUpstreamCache(projectKey, target.adapter.id, target.ref.externalKey, cacheScope)

  // Match the original task-provider contract: every list read asks the
  // provider for current issues. SQLite is an offline fallback, never the
  // normal page-entry result, so opening Tasks does not begin stale by design.
  try {
    const result = await target.adapter.listTickets(target.ref, {
      involvement: opts?.involvement,
      query,
    })
    const fetchedAt = Date.now()
    if (!query) {
      writeUpstreamCache(projectKey, target.adapter.id, target.ref.externalKey, result, fetchedAt, cacheScope)
    }
    return {
      ...result,
      tasks: withoutMirroredTickets(result.tasks, target).map((task) => withProjectKey(task, cwd)),
      fetchedAt,
    }
  } catch (error) {
    if (cached) {
      log.warn('upstream_task_list_served_from_cache', {
        projectKey,
        provider: target.adapter.id,
        cachedTaskCount: cached.tasks.length,
        error: error instanceof Error ? error.message : String(error),
      })
      return {
        ...cached,
        tasks: withoutMirroredTickets(cached.tasks, target).map((task) => withProjectKey(task, cwd)),
        fromCache: true,
      }
    }
    throw classifyProviderError(error)
  }
}

export async function getUpstreamTask(cwd: string, id: string): Promise<Task> {
  const target = await resolveTaskPublishTarget(cwd)
  if (!target) throw new Error('This project has no upstream task provider.')
  // Provider-owned rows have no local source of truth. A detail read always
  // reaches the provider; the list cache is only an offline list fallback.
  const url = await target.adapter.ticketUrl(target.ref, id)
  const ticket = await target.adapter.fetchTicket(refFor(target, id, url))
  return taskFromTicket(ticket, cwd)
}

export async function updateUpstreamTask(cwd: string, id: string, patch: TaskUpdatePatch): Promise<Task> {
  const target = await resolveTaskPublishTarget(cwd)
  if (!target) throw new Error('This project has no upstream task provider.')
  const unsupported = Object.keys(patch).filter((field) => !isTaskSyncField(field))
  if (unsupported.length) {
    throw new Error(`${target.adapter.id} cannot update ${unsupported.join(', ')} on a provider-owned ticket.`)
  }
  const ticketPatch: TicketPatch = {}
  if (patch.title !== undefined) ticketPatch.title = patch.title
  if (patch.body !== undefined) ticketPatch.body = patch.body
  if (patch.status !== undefined) ticketPatch.status = patch.status
  if (patch.labels !== undefined) ticketPatch.labels = patch.labels
  if (patch.priority !== undefined) ticketPatch.priority = patch.priority
  if (patch.assignee !== undefined) ticketPatch.assignee = patch.assignee
  const unavailable = Object.keys(ticketPatch).filter((field) =>
    isTaskSyncField(field) && !target.adapter.writableFields.has(field))
  if (unavailable.length) {
    throw new Error(`${target.adapter.id} cannot update ${unavailable.join(', ')} on a provider-owned ticket.`)
  }
  const url = await target.adapter.ticketUrl(target.ref, id)
  const ref = refFor(target, id, url)
  // A mirrored ticket takes the same pasted attachments as a linked one, and the
  // adapter is the one place that knows how to put them on a provider. The sent
  // body is derived here and never written back: otherwise this path would send
  // a literal `asset://` reference that only this host can resolve.
  if (ticketPatch.body !== undefined) {
    requirePublishableAssets(target, ticketPatch.body)
    ticketPatch.body = await target.adapter.publishAssets(ref, ticketPatch.body)
  }
  const ticket = await target.adapter.pushFields(ref, ticketPatch)
  return taskFromTicket(ticket, cwd)
}

/** People the configured provider permits tasks in this project to use. */
export async function listTaskAssigneeCandidates(cwd: string): Promise<TaskAssigneeCandidate[]> {
  const target = await resolveTaskPublishTarget(cwd)
  if (!target?.adapter.listAssigneeCandidates) return []
  return target.adapter.listAssigneeCandidates(target.ref)
}

export async function commentOnUpstreamTask(cwd: string, id: string, body: string): Promise<Task> {
  const target = await resolveTaskPublishTarget(cwd)
  if (!target) throw new Error('This project has no upstream task provider.')
  const url = await target.adapter.ticketUrl(target.ref, id)
  const ref = refFor(target, id, url)
  requirePublishableAssets(target, body)
  await target.adapter.postComment(ref, await target.adapter.publishAssets(ref, body))
  return taskFromTicket(await target.adapter.fetchTicket(ref), cwd)
}

/** A body whose attachments this provider cannot host must not be sent with the
 * references silently left as local `asset://` URLs nobody else can resolve. */
function requirePublishableAssets(target: TaskPublishTarget, body: string): void {
  const blocked = target.adapter.unpublishableAssets(body)
  if (!blocked.length) return
  throw new Error(
    `${target.adapter.id} cannot host .${blocked[0].extension} attachments. `
    + 'Add the file with the provider composer instead.',
  )
}

function configuredRepo(
  config: Awaited<ReturnType<typeof loadProjectConfig>>,
): RepoRef | undefined {
  const owner = config?.taskProviderConfig?.owner?.trim()
  const repo = config?.taskProviderConfig?.repo?.trim()
  return owner && repo ? { host: 'github.com', owner, repo } : undefined
}

function classifyProviderError(error: Parameters<typeof String>[0]): Error {
  const cause = error instanceof Error ? error : new Error(String(error))
  const message = cause.message
  if (message.startsWith(TASKS_AUTH_ERROR_PREFIX)) return cause
  if (
    error instanceof GitHubReauthRequiredError
    || /not connected|bad credentials|reconnect|401|unauthorized/i.test(message)
  ) {
    return new Error(`${TASKS_AUTH_ERROR_PREFIX}${message}`)
  }
  return cause
}

export async function taskProviderStatus(
  cwd: string,
  opts: { checkAccess?: boolean } = {},
): Promise<TaskProviderStatus> {
  const config = await loadProjectConfig(cwd)
  const provider = config?.taskProvider ?? 'local'
  if (provider === 'local') {
    const detected = await resolveRepoRef(cwd)
    const detectedGitHub = detected?.host.toLowerCase() === 'github.com' ? detected : undefined
    return {
      provider,
      ok: true,
      reason: 'ok',
      message: 'Using Solus local tasks for this project.',
      detectedRepo: detectedGitHub
        ? { owner: detectedGitHub.owner, repo: detectedGitHub.repo }
        : undefined,
    }
  }
  if (provider === 'jira') return jiraProviderStatus(config)
  if (provider !== 'github') {
    return {
      provider,
      ok: false,
      reason: 'unsupported_provider',
      message: `${provider} task integration is not available yet.`,
    }
  }

  const detected = await resolveRepoRef(cwd)
  const detectedGitHub = detected?.host.toLowerCase() === 'github.com' ? detected : undefined
  const explicitRepo = configuredRepo(config)
  const repo = explicitRepo ? { ...explicitRepo, source: 'config' as const } : undefined

  if (!detectedGitHub) {
    return {
      provider,
      ok: false,
      reason: 'missing_binding',
      message: 'GitHub tasks need a GitHub origin remote for this project.',
      scopeLabel: repo ? `${repo.owner}/${repo.repo}` : undefined,
      repo,
    }
  }

  if (!repo) {
    return {
      provider,
      ok: false,
      reason: 'missing_binding',
      message: `Bind GitHub tasks to this project's repository, ${detectedGitHub.owner}/${detectedGitHub.repo}.`,
      detectedRepo: { owner: detectedGitHub.owner, repo: detectedGitHub.repo },
    }
  }
  if (repo.owner !== detectedGitHub.owner || repo.repo !== detectedGitHub.repo) {
    return {
      provider,
      ok: false,
      reason: 'missing_binding',
      message: `This project uses ${detectedGitHub.owner}/${detectedGitHub.repo}, not ${repo.owner}/${repo.repo}. Rebind GitHub to the underlying repository.`,
      scopeLabel: `${repo.owner}/${repo.repo}`,
      repo,
      detectedRepo: { owner: detectedGitHub.owner, repo: detectedGitHub.repo },
    }
  }

  const auth = await new GitHubAuth().status()
  const credentials = await githubCredentialChain(repo.host, cwd)
  const hasProjectScope = auth.connected ? auth.scopes?.includes('project') === true : undefined
  if (credentials.length === 0) {
    return {
      provider,
      ok: false,
      reason: 'not_connected',
      message: `Connect GitHub to load issues from ${repo.owner}/${repo.repo}.`,
      repo,
      detectedRepo: { owner: detectedGitHub.owner, repo: detectedGitHub.repo },
      auth: { connected: false },
    }
  }

  let liveCheck: TaskProviderStatus['liveCheck'] | undefined
  let accessWarning: string | undefined
  if (opts.checkAccess) {
    try {
      const target = await resolveTaskPublishTarget(cwd)
      if (!target) throw new Error('This project has no upstream task provider.')
      const list = await target.adapter.listTickets(target.ref)
      liveCheck = {
        checkedAt: Date.now(),
        issueCount: list.tasks.length,
        truncated: list.truncated,
        planningFieldsDetected: list.tasks.some((task) => task.canEditPlanningFields === true),
      }
      if (!hasProjectScope) {
        accessWarning = 'Reconnect GitHub to load Projects fields for upstream tasks.'
      } else if (list.tasks.length > 0 && !liveCheck.planningFieldsDetected) {
        accessWarning = 'Issues are reachable, but no Projects fields were detected on the sampled issues.'
      }
    } catch (error) {
      const classified = classifyProviderError(error)
      const message = classified instanceof Error ? classified.message : String(classified)
      return {
        provider,
        ok: false,
        reason: message.includes(TASKS_AUTH_ERROR_PREFIX) ? 'not_connected' : 'access_failed',
        message: message.replace(TASKS_AUTH_ERROR_PREFIX, ''),
        repo,
        detectedRepo: { owner: detectedGitHub.owner, repo: detectedGitHub.repo },
      auth: { connected: true, login: auth.login, hasProjectScope },
      }
    }
  }

  return {
    provider,
    ok: true,
    reason: 'ok',
    message: `Loading GitHub issues from ${repo.owner}/${repo.repo} alongside local tasks.`,
    scopeLabel: `${repo.owner}/${repo.repo}`,
    repo,
    detectedRepo: { owner: detectedGitHub.owner, repo: detectedGitHub.repo },
    auth: { connected: true, login: auth.login, hasProjectScope },
    liveCheck,
    warning: accessWarning,
    writableFields: [...taskSyncAdapter('github').writableFields],
    statuses: [...taskSyncAdapter('github').statuses],
  }
}

/** Jira connection and pinned-project preflight. Live issue reads remain owned
 * by listUpstreamTasks, the same path GitHub uses. */
async function jiraProviderStatus(
  config: Awaited<ReturnType<typeof loadProjectConfig>>,
): Promise<TaskProviderStatus> {
  const site = await connectedSite('jira')
  if (!site) {
    return {
      provider: 'jira',
      ok: false,
      reason: 'not_connected',
      message: 'Connect Atlassian to sync tasks with Jira.',
      auth: { connected: false },
    }
  }
  const projectKey = config?.taskProviderConfig?.projectKey?.trim()
  if (!projectKey) {
    return {
      provider: 'jira',
      ok: false,
      reason: 'missing_binding',
      message: 'Jira tasks need a project. Choose one for this project.',
      auth: { connected: true },
    }
  }
  const boundCloudId = config?.taskProviderConfig?.cloudId?.trim() ?? site.cloudId
  if (boundCloudId !== site.cloudId) {
    return {
      provider: 'jira',
      ok: false,
      reason: 'not_connected',
      message: `This project is bound to a different Atlassian site than the connected one (${site.siteUrl}).`,
      scopeLabel: projectKey,
      auth: { connected: true },
    }
  }
  return {
    provider: 'jira',
    ok: true,
    reason: 'ok',
    message: `Publishing and importing Jira issues in ${projectKey} on ${site.siteUrl}.`,
    scopeLabel: projectKey,
    auth: { connected: true },
    writableFields: [...taskSyncAdapter('jira').writableFields],
    statuses: [...taskSyncAdapter('jira').statuses],
  }
}
