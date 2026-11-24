import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { ProjectConfig } from '@solus/contracts/types'
import { worktreeBranchNamingSchema } from '@solus/contracts/worktree-branch-naming'
import { MAX_DEVICE_RUN_PROFILES, deviceRunProfileSchema } from '@solus/contracts/device-types'
import { isTaskFolderPath } from '@solus/contracts/codebases'
import { worktreeProjectRoot } from '@solus/contracts/types'
import { git, gitOutputPath } from '../git/exec'

/**
 * Project config lives in the repository, at `.solus/config.json`.
 *
 * In the repo rather than in the host database because it describes the
 * project, not the machine: whether a merged pull request closes its task, how
 * a worktree branch is named. That is a team decision, so it is committable,
 * reviewable in a pull request, and editable by an agent with an ordinary file
 * edit. The database row it replaced was addressed by a sha256 of the repo root
 * — correct, but unreadable, and impossible for a user to inspect or share.
 *
 * Task sources are not here: they are the person's own, in their personal
 * settings (docs/tasks.md). A file that still lists them reads without them.
 *
 * `tasks.project_key` is a repository *path*, not this hash, despite the name.
 * Callers that hand it to `loadProjectConfig` are passing a valid working
 * directory.
 */

const PROJECT_CONFIG_DIR = '.solus'
const PROJECT_CONFIG_FILE = 'config.json'

const rootByCwd = new Map<string, string>()

const projectConfigInputSchema = z.object({
  serverUrls: z.array(z.string().max(2048).url().refine((raw) => {
    const url = new URL(raw)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(url.hostname)
  }, 'Use a local HTTP or HTTPS URL without credentials.')).max(16).optional(),
  taskDoneOnMerge: z.boolean().optional(),
  // A malformed override is dropped, not fatal: the rest of the file still applies.
  worktreeBranchNaming: worktreeBranchNamingSchema.optional().catch(undefined),
  deviceRuns: z.array(deviceRunProfileSchema).max(MAX_DEVICE_RUN_PROFILES).optional().catch(undefined),
  ignoreRepositories: z.array(z.string().min(1).max(4096)).max(512).optional().catch(undefined),
  worktreeLayout: z.object({
    create: z.string().trim().min(1).max(4096),
    remove: z.string().trim().min(1).max(4096).optional(),
  }).optional().catch(undefined),
})

type ProjectConfigInput = z.infer<typeof projectConfigInputSchema>

/**
 * The repository a working directory belongs to, with the Solus worktree
 * segment stripped, so every worktree of a repo reads and writes one config.
 * The path of a worktree in a task folder does not name its repository, so
 * Git answers for it. A folder of a task folder that is in no worktree stands
 * in for a plain member through links, so it answers itself, and its config
 * file is the linked one of the member.
 *
 * Memoized: the toplevel for a cwd is stable for the process lifetime, and this
 * sync git spawn would otherwise block the main process on every config call.
 */
export function resolveProjectRoot(cwd: string): string {
  const cached = rootByCwd.get(cwd)
  if (cached) return cached
  let root: string
  try {
    const checkoutRoot = gitOutputPath(cwd, git(['rev-parse', '--show-toplevel'], cwd, { timeout: 5_000 }))
    root = isTaskFolderPath(checkoutRoot) ? repositoryOfWorktree(checkoutRoot) : worktreeProjectRoot(checkoutRoot)
  } catch {
    // Not a repository — the directory is its own project.
    root = cwd
  }
  rootByCwd.set(cwd, root)
  return root
}

/**
 * The repository that a linked worktree at `checkoutRoot` is a checkout of:
 * the folder of the Git directory that its worktrees share. A checkout that
 * is not a linked worktree of a repository (a submodule in a worktree)
 * answers itself.
 */
function repositoryOfWorktree(checkoutRoot: string): string {
  const sharedGitDirectory = gitOutputPath(checkoutRoot, git(['rev-parse', '--git-common-dir'], checkoutRoot, { timeout: 5_000 }))
  return basename(sharedGitDirectory) === '.git' ? dirname(sharedGitDirectory) : checkoutRoot
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
  if (raw.taskDoneOnMerge !== undefined) {
    config.taskDoneOnMerge = raw.taskDoneOnMerge
  }
  if (raw.worktreeBranchNaming !== undefined) {
    config.worktreeBranchNaming = raw.worktreeBranchNaming
  }
  if (raw.serverUrls) config.serverUrls = [...new Set(raw.serverUrls)]
  if (raw.deviceRuns?.length) config.deviceRuns = raw.deviceRuns
  if (raw.ignoreRepositories?.length) config.ignoreRepositories = [...new Set(raw.ignoreRepositories)]
  if (raw.worktreeLayout) config.worktreeLayout = raw.worktreeLayout
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

/**
 * The `ignoreRepositories` of the config file in `folder` itself
 * (docs/plans/codebases.md §5). A root of a codebase can be a folder with no
 * repository, so this reads `<folder>/.solus/config.json` and does not ask Git
 * for the repository that holds the folder.
 */
export async function readIgnoredRepositories(folder: string): Promise<string[]> {
  return (await readFolderConfig(folder))?.ignoreRepositories ?? []
}

/**
 * The `worktreeLayout` commands of the config file in `folder` itself
 * (docs/plans/codebases.md §7), or null. The working member of a task folder
 * can be a folder with no repository, so this does not ask Git either.
 */
export async function readWorktreeLayout(folder: string): Promise<NonNullable<ProjectConfig['worktreeLayout']> | null> {
  return (await readFolderConfig(folder))?.worktreeLayout ?? null
}

async function readFolderConfig(folder: string): Promise<ProjectConfig | null> {
  const text = await readFile(join(folder, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE), 'utf-8').catch(() => null)
  return text === null ? null : parseConfig(text)
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
