import { createLogger } from '../logger'
import { getDb } from '../db'
import { loadProjectConfig, resolveProjectKey } from '../project-config/project-config'
import { makeGitHubTaskProvider, type GitHubTaskProvider } from './providers/github'
import { linkedExternalIds } from './task-sync-store'
import { resolveRepoRef } from '../git/git-helpers'
import { GitHubAuth } from '../providers/github/auth'
import { GitHubReauthRequiredError } from '../providers/github/octokit'
import type { RepoRef } from '../../shared/providers'
import {
  TASKS_AUTH_ERROR_PREFIX,
  type Task,
  type TaskListResult,
  type TaskProviderStatus,
  type TaskUpdatePatch,
} from '../../shared/task-types'

const log = createLogger('main', 'tasks-upstream')

/** Disposable project-scoped provider binding cache. */
const githubProviderCache = new Map<string, Promise<GitHubTaskProvider>>()

interface UpstreamTaskCacheRow {
  fetched_at: number
  truncated: number | null
  tasks: string
}

// The cache key's `scope` column predates the removal of assignee-scoped
// reads; every snapshot is now the complete list.
const CACHE_SCOPE = 'all'

function readUpstreamCache(
  projectKey: string,
  provider: string,
): { tasks: Task[]; fetchedAt: number; truncated?: boolean } | null {
  const row = getDb().prepare(`
    SELECT fetched_at, truncated, tasks
    FROM upstream_task_cache
    WHERE project_key = ? AND provider = ? AND scope = ?
  `).get(projectKey, provider, CACHE_SCOPE) as UpstreamTaskCacheRow | undefined
  if (!row) return null
  try {
    return {
      tasks: JSON.parse(row.tasks) as Task[],
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
  result: { tasks: Task[]; truncated?: boolean },
  fetchedAt: number,
): void {
  getDb().prepare(`
    INSERT INTO upstream_task_cache(project_key, provider, scope, fetched_at, truncated, tasks)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_key, provider, scope) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      truncated = excluded.truncated,
      tasks = excluded.tasks
  `).run(
    projectKey,
    provider,
    CACHE_SCOPE,
    fetchedAt,
    result.truncated === undefined ? null : result.truncated ? 1 : 0,
    JSON.stringify(result.tasks),
  )
}

async function githubProvider(cwd: string): Promise<GitHubTaskProvider | null> {
  const config = await loadProjectConfig(cwd)
  if ((config?.taskProvider ?? 'local') !== 'github') return null
  const projectKey = resolveProjectKey(cwd)
  let provider = githubProviderCache.get(projectKey)
  if (!provider) {
    provider = makeGitHubTaskProvider(cwd, configuredRepo(config)).catch((error) => {
      githubProviderCache.delete(projectKey)
      throw classifyProviderError(error)
    })
    githubProviderCache.set(projectKey, provider)
  }
  return provider
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
function withoutMirroredTickets(tasks: Task[], provider: GitHubTaskProvider): Task[] {
  const mirrored = linkedExternalIds(provider.id, `${provider.repo.owner}/${provider.repo.repo}`)
  return mirrored.size ? tasks.filter((task) => !mirrored.has(task.id)) : tasks
}

/** Read the configured upstream alongside native Solus tasks. Local remains the
 * durable source for Solus-owned work; these rows retain provider ownership. */
export async function listUpstreamTasks(
  cwd: string,
  _opts: { refresh?: boolean } | null = {},
): Promise<TaskListResult> {
  const provider = await githubProvider(cwd)
  if (!provider) return { tasks: [] }
  const projectKey = resolveProjectKey(cwd)
  const cached = readUpstreamCache(projectKey, provider.id)

  // Match the original task-provider contract: every list read asks the
  // provider for current issues. SQLite is an offline fallback, never the
  // normal page-entry result, so opening Tasks does not begin stale by design.
  try {
    const result = await provider.listTasks()
    const fetchedAt = Date.now()
    writeUpstreamCache(projectKey, provider.id, result, fetchedAt)
    return {
      ...result,
      tasks: withoutMirroredTickets(result.tasks, provider).map((task) => withProjectKey(task, cwd)),
      fetchedAt,
    }
  } catch (error) {
    if (cached) {
      log.warn('upstream_task_list_served_from_cache', {
        projectKey,
        provider: provider.id,
        cachedTaskCount: cached.tasks.length,
        error: error instanceof Error ? error.message : String(error),
      })
      return {
        ...cached,
        tasks: withoutMirroredTickets(cached.tasks, provider).map((task) => withProjectKey(task, cwd)),
        fromCache: true,
      }
    }
    throw classifyProviderError(error)
  }
}

export async function getUpstreamTask(cwd: string, id: string): Promise<Task> {
  const provider = await githubProvider(cwd)
  if (!provider) throw new Error('This project has no upstream task provider.')
  const projectKey = resolveProjectKey(cwd)
  // A list snapshot contains the complete issue shape used by the detail page.
  // Prefer it for a single lookup; only a genuine cache miss reaches GitHub.
  const cachedTask = readUpstreamCache(projectKey, provider.id)
    ?.tasks.find((candidate) => candidate.id === id)
  if (cachedTask) return withProjectKey(cachedTask, cwd)
  return withProjectKey(await provider.getTask(id), cwd)
}

export async function updateUpstreamTask(cwd: string, id: string, patch: TaskUpdatePatch): Promise<Task> {
  const provider = await githubProvider(cwd)
  if (!provider) throw new Error('This project has no upstream task provider.')
  return withProjectKey(await provider.updateTask(id, patch), cwd)
}

export async function commentOnUpstreamTask(cwd: string, id: string, body: string): Promise<Task> {
  const provider = await githubProvider(cwd)
  if (!provider) throw new Error('This project has no upstream task provider.')
  await provider.postComment(id, body)
  return withProjectKey(await provider.getTask(id), cwd)
}

function configuredRepo(
  config: Awaited<ReturnType<typeof loadProjectConfig>>,
): RepoRef | undefined {
  const owner = config?.taskProviderConfig?.owner?.trim()
  const repo = config?.taskProviderConfig?.repo?.trim()
  return owner && repo ? { host: 'github.com', owner, repo } : undefined
}

function classifyProviderError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith(TASKS_AUTH_ERROR_PREFIX)) return error
  if (
    error instanceof GitHubReauthRequiredError
    || /not connected|bad credentials|reconnect|401|unauthorized/i.test(message)
  ) {
    return new Error(`${TASKS_AUTH_ERROR_PREFIX}${message}`)
  }
  return error
}

export async function taskProviderStatus(
  cwd: string,
  opts: { checkAccess?: boolean } = {},
): Promise<TaskProviderStatus> {
  const config = await loadProjectConfig(cwd)
  const provider = config?.taskProvider ?? 'local'
  if (provider === 'local') {
    return {
      provider,
      ok: true,
      reason: 'ok',
      message: 'Using Solus local tasks for this project.',
    }
  }
  if (provider !== 'github') {
    return {
      provider,
      ok: false,
      reason: 'unsupported_provider',
      message: `${provider} task integration is not available yet.`,
    }
  }

  const explicitRepo = configuredRepo(config)
  const detected = await resolveRepoRef(cwd)
  const repo = explicitRepo
    ? { ...explicitRepo, source: 'config' as const }
    : detected
      ? { owner: detected.owner, repo: detected.repo, source: 'origin' as const }
      : undefined
  const auth = await new GitHubAuth().status()
  const hasProjectScope = auth.connected ? auth.scopes?.includes('project') === true : undefined

  if (!repo) {
    return {
      provider,
      ok: false,
      reason: 'missing_github_repo',
      message: 'GitHub tasks need a repository. Set owner/repo here or add a GitHub origin remote.',
      auth: { connected: auth.connected, login: auth.login, hasProjectScope },
    }
  }
  if (!auth.connected) {
    return {
      provider,
      ok: false,
      reason: 'github_not_connected',
      message: `Connect GitHub to load issues from ${repo.owner}/${repo.repo}.`,
      repo,
      detectedRepo: detected ? { owner: detected.owner, repo: detected.repo } : undefined,
      auth: { connected: false },
    }
  }

  let liveCheck: TaskProviderStatus['liveCheck'] | undefined
  let accessWarning: string | undefined
  if (opts.checkAccess) {
    try {
      const boundProvider = await githubProvider(cwd)
      if (!boundProvider) throw new Error('This project has no upstream task provider.')
      const list = await boundProvider.listTasks()
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
        reason: message.includes(TASKS_AUTH_ERROR_PREFIX) ? 'github_not_connected' : 'github_access_failed',
        message: message.replace(TASKS_AUTH_ERROR_PREFIX, ''),
        repo,
        detectedRepo: detected ? { owner: detected.owner, repo: detected.repo } : undefined,
        auth: { connected: true, login: auth.login, hasProjectScope },
      }
    }
  }

  return {
    provider,
    ok: true,
    reason: 'ok',
    message: `Loading GitHub issues from ${repo.owner}/${repo.repo} alongside local tasks.`,
    repo,
    detectedRepo: detected ? { owner: detected.owner, repo: detected.repo } : undefined,
    auth: { connected: true, login: auth.login, hasProjectScope },
    liveCheck,
    warning: accessWarning,
  }
}

/** Project config changed; discard the cached provider binding. */
export function invalidateTaskProvider(cwd: string): void {
  githubProviderCache.delete(resolveProjectKey(cwd))
}
