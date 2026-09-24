import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ProjectConfig } from '@solus/contracts/types'
import { worktreeProjectRoot } from '@solus/contracts/types'
import { git } from '../git/exec'

/**
 * Project config lives in the repository, at `.solus/config.json`.
 *
 * In the repo rather than in the host database because it describes the
 * project, not the machine: which task provider the project uses, which Jira
 * project its work files under. That is a team decision, so it is committable,
 * reviewable in a pull request, and editable by an agent with an ordinary file
 * edit. The database row it replaced was addressed by a sha256 of the repo root
 * — correct, but unreadable, and impossible for a user to inspect or share.
 *
 * `tasks.project_key` is a repository *path*, not this hash, despite the name.
 * Callers that hand it to `loadProjectConfig` are passing a valid working
 * directory.
 */

const PROJECT_CONFIG_DIR = '.solus'
const PROJECT_CONFIG_FILE = 'config.json'

const rootByCwd = new Map<string, string>()

const projectConfigInputSchema = z.object({
  taskProvider: z.enum(['github', 'jira', 'local']).optional(),
  taskProviderConfig: z.object({
    owner: z.string().optional(),
    repo: z.string().optional(),
    cloudId: z.string().optional(),
    projectKey: z.string().optional(),
  }).optional(),
  tasksAutoPushComments: z.boolean().optional(),
  taskDoneOnMerge: z.boolean().optional(),
})

type ProjectConfigInput = z.infer<typeof projectConfigInputSchema>

/**
 * The repository a working directory belongs to, with the Solus worktree
 * segment stripped, so every worktree of a repo reads and writes one config.
 *
 * Memoized: the toplevel for a cwd is stable for the process lifetime, and this
 * sync git spawn would otherwise block the main process on every config call.
 */
export function resolveProjectRoot(cwd: string): string {
  const cached = rootByCwd.get(cwd)
  if (cached) return cached
  let root: string
  try {
    root = worktreeProjectRoot(git(['rev-parse', '--show-toplevel'], cwd, { timeout: 5_000 }))
  } catch {
    // Not a repository — the directory is its own project.
    root = cwd
  }
  rootByCwd.set(cwd, root)
  return root
}

/** Stable key for a project, used to co-locate per-host data such as the
 *  projects manifest and the recents list. No longer addresses project config. */
export function resolveProjectKey(cwd: string): string {
  return createHash('sha256').update(resolveProjectRoot(cwd)).digest('hex')
}

export function projectConfigPath(cwd: string): string {
  return join(resolveProjectRoot(cwd), PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE)
}

function normalizeConfig(raw: ProjectConfigInput): ProjectConfig {
  const config: ProjectConfig = { version: 1 }
  if (raw.taskProvider !== undefined) {
    config.taskProvider = raw.taskProvider
  }
  const providerConfig = raw.taskProviderConfig
  if (providerConfig?.owner || providerConfig?.repo || providerConfig?.cloudId || providerConfig?.projectKey) {
    config.taskProviderConfig = {}
    if (providerConfig.owner !== undefined) config.taskProviderConfig.owner = providerConfig.owner
    if (providerConfig.repo !== undefined) config.taskProviderConfig.repo = providerConfig.repo
    if (providerConfig.cloudId !== undefined) config.taskProviderConfig.cloudId = providerConfig.cloudId
    if (providerConfig.projectKey !== undefined) {
      config.taskProviderConfig.projectKey = providerConfig.projectKey
    }
  }
  if (raw.tasksAutoPushComments !== undefined) {
    config.tasksAutoPushComments = raw.tasksAutoPushComments
  }
  if (raw.taskDoneOnMerge !== undefined) {
    config.taskDoneOnMerge = raw.taskDoneOnMerge
  }
  return config
}

function parseConfig(text: string): ProjectConfig | null {
  try {
    const result = projectConfigInputSchema.safeParse(JSON.parse(text))
    return result.success ? normalizeConfig(result.data) : null
  } catch {
    return null
  }
}

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig | null> {
  const path = projectConfigPath(cwd)
  return existsSync(path) ? parseConfig(readFileSync(path, 'utf-8')) : null
}

export async function saveProjectConfig(cwd: string, config: ProjectConfig): Promise<ProjectConfig> {
  const normalized = normalizeConfig(projectConfigInputSchema.parse(config))
  writeConfigFile(projectConfigPath(cwd), normalized)
  return normalized
}

/** Trailing newline because this file is meant to be committed and diffed. */
function writeConfigFile(path: string, config: ProjectConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
}
