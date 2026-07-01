import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createLogger } from '../logger'
import { writeJson } from '../project-config/json-file'
import { loadProjectConfig, resolveProjectKey } from '../project-config/project-config'
import { LocalTaskProvider } from './providers/local'
import { GitHubTaskProvider, makeGitHubTaskProvider, type GitHubTaskRaw } from './providers/github'
import { getExistingPR } from '../git/worktree-manager'
import { type Task, type TaskProvider, taskPrFromUrl } from '../../shared/task-types'

const log = createLogger('main', 'task-service')

// Disposable provider cache — the provider stays the source of truth, so this is
// only a fast/offline read of the last-seen list. Local projects skip it (their
// store IS the source). See the Task System Design work (strategy B).
const CACHE_ROOT = join(homedir(), '.solus', 'tasks', 'cache')
const githubProviderCache = new Map<string, Promise<GitHubTaskProvider>>()

function cachePath(projectKey: string): string {
  return join(CACHE_ROOT, `${projectKey}.json`)
}

/**
 * Resolve the single task provider a project uses. `taskProvider: 'github'` binds
 * the GitHub provider (repo auto-detected from the origin remote); everything
 * else — including an unset provider — falls back to the local store, which is
 * always available and never needs auth.
 */
export async function resolveProvider(cwd: string): Promise<TaskProvider> {
  const config = await loadProjectConfig(cwd)
  if (config?.taskProvider === 'github') {
    try {
      const projectKey = resolveProjectKey(cwd)
      const cached = githubProviderCache.get(projectKey)
      if (cached) return await cached
      const pending = makeGitHubTaskProvider(cwd).catch((err) => {
        githubProviderCache.delete(projectKey)
        throw err
      })
      githubProviderCache.set(projectKey, pending)
      return await pending
    } catch (err) {
      // A misconfigured/undetectable remote shouldn't strand the user with no
      // tasks UI — degrade to local rather than throwing up the stack.
      log.warn(`GitHub provider unavailable, falling back to local: ${String(err)}`)
    }
  }
  return new LocalTaskProvider(resolveProjectKey(cwd))
}

async function readCache(projectKey: string): Promise<Task[] | null> {
  const path = cachePath(projectKey)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Task[]
  } catch (err) {
    log.error(`readCache(${projectKey}) failed: ${String(err)}`)
    return null
  }
}

/**
 * List a project's tasks. For remote providers the live result is cached so a
 * later API failure (offline, rate limit, revoked token) degrades to the last
 * seen list instead of an empty page. Local tasks read straight through.
 */
export async function listTasks(
  cwd: string,
  opts: { query?: string; assignedToMe?: boolean } = {},
): Promise<Task[]> {
  const provider = await resolveProvider(cwd)
  if (provider.id === 'local') return provider.listTasks(opts)

  const projectKey = resolveProjectKey(cwd)
  try {
    const tasks = await provider.listTasks(opts)
    await writeJson(cachePath(projectKey), tasks)
    return tasks
  } catch (err) {
    const cached = await readCache(projectKey)
    if (cached) {
      log.warn(`listTasks live fetch failed; serving ${cached.length} cached tasks: ${String(err)}`)
      return cached
    }
    throw err
  }
}

export async function getTask(cwd: string, id: string): Promise<Task> {
  const provider = await resolveProvider(cwd)
  const task = await provider.getTask(id)
  // Keep the captured PR fresh: once a task knows its branch, re-resolve the PR
  // on hydration (the detail view's read path) so a PR opened after the branch
  // was captured shows up without manual entry. Best-effort + local-only — the
  // gh lookup can fail offline, and remote providers don't persist these fields.
  if (task.branch && provider.id === 'local' && provider.updateTask) {
    try {
      const url = await getExistingPR(task.branch, cwd)
      const pr = taskPrFromUrl(url)
      if (pr?.url !== task.pr?.url) return provider.updateTask(id, { pr: pr ?? undefined })
    } catch (err) {
      log.warn(`PR refresh for task ${id} failed: ${String(err)}`)
    }
  }
  return task
}

export async function updateTask(cwd: string, id: string, patch: Partial<Task>): Promise<Task> {
  const provider = await resolveProvider(cwd)
  if (!provider.updateTask) throw new Error(`Provider ${provider.id} does not support updating tasks`)
  return provider.updateTask(id, patch)
}

export async function createTask(cwd: string, input: Partial<Task>): Promise<Task> {
  const provider = await resolveProvider(cwd)
  if (!provider.createTask) throw new Error(`Provider ${provider.id} does not support creating tasks`)
  return provider.createTask(input)
}

export async function deleteTask(cwd: string, id: string): Promise<boolean> {
  const provider = await resolveProvider(cwd)
  if (!provider.deleteTask) throw new Error(`Provider ${provider.id} does not support deleting tasks`)
  return provider.deleteTask(id)
}

/**
 * The write-back loop, fired once when a session binds to a task: move the ticket
 * to In Progress (label on GitHub, field on local) and post a "started in Solus"
 * note so teammates see the work picked up. Entirely best-effort and narrow — the
 * provider stays the source of truth, we only nudge status + leave a breadcrumb.
 * A failure here must never block the session, so the caller swallows throws.
 */
export async function startTaskWork(cwd: string, id: string, knownTask?: Task): Promise<void> {
  const provider = await resolveProvider(cwd)
  const task = knownTask ?? await provider.getTask(id)
  // Only act on first pickup: an already in-progress / done ticket shouldn't be
  // churned or re-commented every time another session binds to it.
  if (task.status !== 'open') return
  if (provider instanceof GitHubTaskProvider) {
    await provider.startTaskWork(id, task)
    return
  }
  if (provider.updateTask) await provider.updateTask(id, { status: 'in_progress' })
  if (provider.postComment) {
    await provider.postComment(id, 'Started working on this in [Solus](https://solus.chat).')
  }
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
  await provider.postComment(id, body)
  return getTask(cwd, id)
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
