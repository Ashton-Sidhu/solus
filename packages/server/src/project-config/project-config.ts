import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ProjectConfig } from '@solus/contracts/types'
import { worktreeProjectRoot } from '@solus/contracts/types'
import { worktreeBranchNamingSchema } from '@solus/contracts/worktree-branch-naming'
import { MAX_DEVICE_RUN_PROFILES, deviceRunProfileSchema } from '@solus/contracts/device-types'
import { MAX_TASK_SOURCES, taskSourceKey, taskSourceSchema, type TaskSource } from '@solus/contracts/task-sources'
import { git, gitOutputPath } from '../git/exec'

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
  taskDoneOnMerge: z.boolean().optional(),
  // One malformed source is dropped; the others still apply.
  taskSources: z.array(taskSourceSchema.nullable().catch(null)).max(MAX_TASK_SOURCES).optional().catch(undefined),
  defaultTaskSource: z.string().optional().catch(undefined),
  // A malformed override is dropped, not fatal: the rest of the file still applies.
  worktreeBranchNaming: worktreeBranchNamingSchema.optional().catch(undefined),
  deviceRuns: z.array(deviceRunProfileSchema).max(MAX_DEVICE_RUN_PROFILES).optional().catch(undefined),
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
    root = worktreeProjectRoot(gitOutputPath(cwd, git(['rev-parse', '--show-toplevel'], cwd, { timeout: 5_000 })))
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

/** A project lists a source one time: the same board twice would show each task twice. */
function distinctTaskSources(sources: readonly (TaskSource | null)[]): TaskSource[] {
  const bySourceKey = new Map<string, TaskSource>()
  for (const source of sources) {
    if (source && !bySourceKey.has(taskSourceKey(source))) bySourceKey.set(taskSourceKey(source), source)
  }
  return [...bySourceKey.values()]
}

function normalizeConfig(raw: ProjectConfigInput): ProjectConfig {
  const config: ProjectConfig = { version: 1 }
  if (raw.taskDoneOnMerge !== undefined) {
    config.taskDoneOnMerge = raw.taskDoneOnMerge
  }
  const taskSources = distinctTaskSources(raw.taskSources ?? [])
  if (taskSources.length) {
    config.taskSources = taskSources
    // A new task needs one place to go, so a project with sources always has a default.
    const sourceKeys = taskSources.map(taskSourceKey)
    config.defaultTaskSource = raw.defaultTaskSource !== undefined && sourceKeys.includes(raw.defaultTaskSource)
      ? raw.defaultTaskSource
      : sourceKeys[0]
  }
  if (raw.worktreeBranchNaming !== undefined) {
    config.worktreeBranchNaming = raw.worktreeBranchNaming
  }
  if (raw.deviceRuns?.length) config.deviceRuns = raw.deviceRuns
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
