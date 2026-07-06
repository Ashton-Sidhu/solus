import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createLogger } from '../logger'
import { writeJson } from '../project-config/json-file'
import { loadProjectConfig, resolveProjectKey } from '../project-config/project-config'
import { LocalTaskProvider } from './providers/local'
import { GitHubTaskProvider, makeGitHubTaskProvider, type GitHubTaskRaw } from './providers/github'
import { resolveRepoRef } from '../git/git-helpers'
import { GitHubAuth } from '../providers/github/auth'
import { GitHubReauthRequiredError } from '../providers/github/octokit'
import { getExistingPR } from '../git/worktree-manager'
import { linkTaskSession } from './task-links'
import type { RepoRef } from '../../shared/providers'
import {
  TASKS_AUTH_ERROR_PREFIX,
  type Task,
  type TaskCommentData,
  type TaskListResult,
  type TaskProvider,
  type TaskProviderRepoRef,
  type TaskProviderStatus,
  taskPrFromUrl,
} from '../../shared/task-types'

const log = createLogger('main', 'task-service')

// Broadcast hook, wired by the RPC layer at startup. Mutations funnel through
// this module (renderer handlers, agent tools, and session write-backs alike),
// so notifying here is the one place that reaches every write path.
let notifyTasksChanged: ((cwd: string) => void) | null = null

export function setTasksChangedNotifier(fn: (cwd: string) => void): void {
  notifyTasksChanged = fn
}

function notify(cwd: string): void {
  notifyTasksChanged?.(cwd)
}

/** Mark auth/connection failures with a stable prefix so the renderer can offer
 *  "Connect GitHub" from a marker instead of sniffing error prose. The
 *  instanceof check catches revoked tokens; the pattern covers the not-connected
 *  throw and raw 401s from the GraphQL client (which has no reauth hook). */
function classifyProviderError(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.startsWith(TASKS_AUTH_ERROR_PREFIX)) return err
  if (err instanceof GitHubReauthRequiredError || /not connected|bad credentials|reconnect|401|unauthorized/i.test(msg)) {
    return new Error(`${TASKS_AUTH_ERROR_PREFIX}${msg}`)
  }
  return err
}

// Disposable provider cache — the provider stays the source of truth, so this is
// only a fast/offline read of the last-seen list. Local projects skip it (their
// store IS the source). See the Task System Design work (strategy B).
const CACHE_ROOT = join(homedir(), '.solus', 'tasks', 'cache')
const githubProviderCache = new Map<string, Promise<GitHubTaskProvider>>()

function cachePath(projectKey: string): string {
  return join(CACHE_ROOT, `${projectKey}.json`)
}

function configuredRepo(
  config: Awaited<ReturnType<typeof loadProjectConfig>>,
): RepoRef | undefined {
  const owner = config?.taskProviderConfig?.owner?.trim()
  const repo = config?.taskProviderConfig?.repo?.trim()
  return owner && repo ? { host: 'github.com', owner, repo } : undefined
}

/**
 * Resolve the single task provider a project uses. `taskProvider: 'github'` binds
 * the GitHub provider (explicit owner/repo when configured, otherwise the
 * origin remote). An explicit remote provider failure is surfaced to the UI
 * rather than silently becoming local tasks; unset/local remains local.
 */
export async function resolveProvider(cwd: string): Promise<TaskProvider> {
  const config = await loadProjectConfig(cwd)
  if (config?.taskProvider === 'github') {
    try {
      const projectKey = resolveProjectKey(cwd)
      const cached = githubProviderCache.get(projectKey)
      if (cached) return await cached
      const pending = makeGitHubTaskProvider(cwd, configuredRepo(config)).catch((err) => {
        githubProviderCache.delete(projectKey)
        throw err
      })
      githubProviderCache.set(projectKey, pending)
      return await pending
    } catch (err) {
      log.warn(`GitHub provider unavailable for configured task provider: ${String(err)}`)
      throw classifyProviderError(err)
    }
  }
  if (config?.taskProvider && config.taskProvider !== 'local') {
    throw new Error(`Task provider ${config.taskProvider} is not supported yet.`)
  }
  return new LocalTaskProvider(resolveProjectKey(cwd))
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
      message: `Connect GitHub to read issues from ${repo.owner}/${repo.repo}.`,
      repo,
      detectedRepo: detected ? { owner: detected.owner, repo: detected.repo } : undefined,
      auth: { connected: false },
    }
  }

  let liveCheck: TaskProviderStatus['liveCheck'] | undefined
  let accessWarning: string | undefined
  if (opts.checkAccess) {
    try {
      const list = await (await makeGitHubTaskProvider(cwd, explicitRepo)).listTasks()
      liveCheck = {
        checkedAt: Date.now(),
        issueCount: list.tasks.length,
        truncated: list.truncated,
        planningFieldsDetected: list.tasks.some((task) => task.canEditPlanningFields === true),
      }
      if (!hasProjectScope) {
        accessWarning = 'Reconnect GitHub to enable Projects fields like status, priority, and due date.'
      } else if (list.tasks.length > 0 && !liveCheck.planningFieldsDetected) {
        accessWarning = 'Issues are reachable, but no Projects fields were detected on the sampled issues.'
      }
    } catch (err) {
      const classified = classifyProviderError(err)
      const message = classified instanceof Error ? classified.message : String(classified)
      const display = message.replace(TASKS_AUTH_ERROR_PREFIX, '')
      return {
        provider,
        ok: false,
        reason: message.includes(TASKS_AUTH_ERROR_PREFIX) ? 'github_not_connected' : 'github_access_failed',
        message: display,
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
    message: `GitHub issues are linked to ${repo.owner}/${repo.repo}.`,
    repo,
    detectedRepo: detected ? { owner: detected.owner, repo: detected.repo } : undefined,
    auth: { connected: true, login: auth.login, hasProjectScope },
    liveCheck,
    warning: accessWarning ?? (hasProjectScope
      ? undefined
      : 'Reconnect GitHub to enable Projects fields like status, priority, and due date.'),
  }
}

/** Invalidate a project's cached provider binding — called when its config is
 *  saved, so switching provider (or fixing the remote) takes effect without an
 *  app restart. */
export function invalidateTaskProvider(cwd: string): void {
  githubProviderCache.delete(resolveProjectKey(cwd))
}

interface TaskCacheFile {
  version: 1
  /** Epoch ms the snapshot was fetched live — surfaced when served offline. */
  fetchedAt: number
  truncated?: boolean
  tasks: Task[]
}

async function readCache(projectKey: string): Promise<TaskCacheFile | null> {
  const path = cachePath(projectKey)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as TaskCacheFile | Task[]
    // Legacy cache files were a bare Task[]; serve them with no fetch time.
    if (Array.isArray(raw)) return { version: 1, fetchedAt: 0, tasks: raw }
    return raw
  } catch (err) {
    log.error(`readCache(${projectKey}) failed: ${String(err)}`)
    return null
  }
}

/**
 * List a project's tasks. For remote providers the live result is cached so a
 * later API failure (offline, rate limit, revoked token) degrades to the last
 * seen list instead of an empty page — flagged `fromCache` (with its original
 * fetch time) so the UI can say so. Local tasks read straight through.
 */
export async function listTasks(
  cwd: string,
  opts: { assignedToMe?: boolean } = {},
): Promise<TaskListResult> {
  const provider = await resolveProvider(cwd)
  if (provider.id === 'local') return provider.listTasks(opts)

  const projectKey = resolveProjectKey(cwd)
  try {
    const list = await provider.listTasks(opts)
    const fetchedAt = Date.now()
    const cache: TaskCacheFile = { version: 1, fetchedAt, truncated: list.truncated, tasks: list.tasks }
    await writeJson(cachePath(projectKey), cache)
    return { ...list, fetchedAt }
  } catch (err) {
    const cached = await readCache(projectKey)
    if (cached) {
      log.warn(`listTasks live fetch failed; serving ${cached.tasks.length} cached tasks: ${String(err)}`)
      return {
        tasks: cached.tasks,
        truncated: cached.truncated,
        fromCache: true,
        fetchedAt: cached.fetchedAt || undefined,
      }
    }
    throw classifyProviderError(err)
  }
}

export async function getTask(cwd: string, id: string): Promise<Task> {
  const provider = await resolveProvider(cwd)
  const task = await provider.getTask(id)
  // Keep the captured PR fresh: once a task knows its branch, re-resolve the PR
  // on hydration (the detail view's read path) so a PR opened after the branch
  // was captured shows up without manual entry — and a stale one is cleared.
  // Best-effort + local-only — the gh lookup can fail offline, and remote
  // providers don't persist these fields. `refreshPr` (not `updateTask`) so
  // this system write never bumps `updatedAt`: reading a task must not reorder
  // it in the "Updated" sort.
  if (task.branch && provider instanceof LocalTaskProvider) {
    try {
      const url = await getExistingPR(task.branch, cwd)
      const pr = taskPrFromUrl(url)
      if ((pr?.url ?? '') !== (task.pr?.url ?? '')) {
        const updated = await provider.refreshPr(id, pr)
        notify(cwd)
        return updated
      }
    } catch (err) {
      log.warn(`PR refresh for task ${id} failed: ${String(err)}`)
    }
  }
  return task
}

export async function updateTask(cwd: string, id: string, patch: Partial<Task>): Promise<Task> {
  const provider = await resolveProvider(cwd)
  if (!provider.updateTask) throw new Error(`Provider ${provider.id} does not support updating tasks`)
  const updated = await provider.updateTask(id, patch)
  notify(cwd)
  return updated
}

export async function createTask(cwd: string, input: Partial<Task>): Promise<Task> {
  const provider = await resolveProvider(cwd)
  if (!provider.createTask) throw new Error(`Provider ${provider.id} does not support creating tasks`)
  const created = await provider.createTask(input)
  notify(cwd)
  return created
}

export async function deleteTask(cwd: string, id: string): Promise<boolean> {
  const provider = await resolveProvider(cwd)
  if (!provider.deleteTask) throw new Error(`Provider ${provider.id} does not support deleting tasks`)
  const deleted = await provider.deleteTask(id)
  if (deleted) notify(cwd)
  return deleted
}

/**
 * The write-back loop, fired once when a session binds to a task: move the ticket
 * to In Progress (label on GitHub, field on local) and post a "started in Solus"
 * note so teammates see the work picked up. Entirely best-effort and narrow — the
 * provider stays the source of truth, we only nudge status + leave a breadcrumb.
 * A failure here must never block the session, so the caller swallows throws.
 */
export async function startTaskWork(cwd: string, id: string, knownTask?: Task): Promise<void> {
  // Respect the per-project opt-out: some users don't want an exploratory
  // session announcing itself on the shared tracker.
  const config = await loadProjectConfig(cwd)
  if (config?.taskStartWriteBack === false) return
  const provider = await resolveProvider(cwd)
  const task = knownTask ?? await provider.getTask(id)
  // Only act on first pickup: an already in-progress / done ticket shouldn't be
  // churned or re-commented every time another session binds to it.
  if (task.status !== 'open') return
  if (provider instanceof GitHubTaskProvider) {
    await provider.startTaskWork(id, task)
  } else {
    if (provider.updateTask) await provider.updateTask(id, { status: 'in_progress' })
    if (provider.postComment) {
      await provider.postComment(id, 'Started working on this in [Solus](https://solus.chat).')
    }
  }
  notify(cwd)
}

/**
 * Post a comment to a task and return it re-hydrated so the new comment shows.
 * GitHub posts a real issue comment; local appends to its own store. Throws if
 * the provider has no comment model (so the caller can keep the draft + surface
 * a toast rather than silently dropping it).
 */
export async function postTaskComment(cwd: string, id: string, body: string): Promise<Task> {
  const provider = await resolveProvider(cwd)
  if (!provider.postComment) throw new Error(`Provider ${provider.id} does not support comments`)
  const posted = await provider.postComment(id, body)
  const task = await getTask(cwd, id)
  // GitHub's GraphQL reads lag its REST writes, so the re-hydration can miss the
  // comment that was just posted — which reads as the comment being eaten. Patch
  // it in from the write's own response when the re-read doesn't carry it yet.
  const raw = task.raw
  if (raw && typeof raw === 'object' && 'comments' in raw) {
    const comments = (raw as { comments: TaskCommentData[] }).comments
    const present = comments.some(
      (c) => (posted.id && c.id === posted.id) || (c.body === posted.body && c.createdAt === posted.createdAt),
    )
    if (!present) comments.push(posted)
  }
  notify(cwd)
  return task
}

export async function linkTaskSessionAndNotify(cwd: string, taskId: string, sessionId: string): Promise<void> {
  await linkTaskSession(cwd, taskId, sessionId)
  notify(cwd)
}

/** Narrow type guard for the GitHub `raw` payload, so formatting stays off `unknown`. */
function asGitHubRaw(raw: unknown): GitHubTaskRaw | null {
  if (raw && typeof raw === 'object' && 'number' in raw && 'comments' in raw) {
    return raw as GitHubTaskRaw
  }
  return null
}

interface TaskAgentTextOptions {
  heading: string
  includeStatus?: boolean
  includeSource?: boolean
  includeHierarchy?: boolean
  includeRefreshHint?: boolean
}

/** Render a hydrated task for agent-facing prompts and tools. */
export function formatTaskForAgent(task: Task, opts: TaskAgentTextOptions): string {
  const lines: string[] = [opts.heading]
  if (opts.includeStatus) lines.push(`status: ${task.status}`)
  if (opts.includeSource) lines.push(`Source: ${task.url ?? `task ${task.id}`}`)
  else if (task.url) lines.push(`url: ${task.url}`)
  if (task.labels.length) lines.push(`Labels: ${task.labels.join(', ')}`)
  if (task.assignee) lines.push(`Assignee: ${task.assignee}`)
  if (opts.includeHierarchy) {
    if (task.childIds?.length) lines.push(`sub-tasks: ${task.childIds.join(', ')}`)
    if (task.parentId) lines.push(`parent epic: ${task.parentId}`)
  }
  lines.push('', task.body.trim() || '(no description)')

  const gh = asGitHubRaw(task.raw)
  if (gh) {
    if (gh.linkedPrs.length) {
      lines.push('', 'Linked pull requests:')
      for (const pr of gh.linkedPrs) lines.push(`- #${pr.number} ${pr.title} (${pr.state}) — ${pr.url}`)
    }
    if (gh.comments.length) {
      lines.push('', 'Comments:')
      for (const c of gh.comments) lines.push(`- ${c.author?.login ?? 'unknown'}: ${c.body.trim()}`)
    }
  }

  if (opts.includeRefreshHint) {
    lines.push(
      '',
      `To re-fetch this task call get_task (task_id: "${task.id}"); to move it call update_task_status.`,
    )
  }
  return lines.join('\n')
}

/**
 * Render a hydrated task into the context block injected at session start, so the
 * agent already knows the ticket (description, comments, linked PRs) instead of
 * having to fetch it. Mirrors the `[Working On - …]` block used for bound works.
 */
export function formatTaskContext(task: Task): string {
  return formatTaskForAgent(task, {
    heading: `[Working On Task — "${task.title}" (${task.providerId} ${task.id}, status: ${task.status})]`,
    includeSource: true,
    includeRefreshHint: true,
  })
}
