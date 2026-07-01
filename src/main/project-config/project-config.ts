import { homedir } from 'os'
import path from 'path'
import { createHash } from 'crypto'
import type { ProjectConfig, RunCommandConfig } from '../../shared/types'
import { worktreeProjectRoot } from '../../shared/types'
import { git } from '../git/exec'
import { readJsonOrNull, writeJson } from './json-file'

const keyByCwd = new Map<string, string>()

/**
 * Stable key for a project, used to co-locate per-project data on disk.
 * Memoized — the repo toplevel for a cwd is stable for the
 * process lifetime and the sync git spawn would otherwise block the main
 * process on every config/run/recents call.
 *
 * For Solus worktrees, the marker is stripped so all worktrees of the same
 * base repo share a single config — consistent with RunManager.configRootFor.
 */
export function resolveProjectKey(cwd: string): string {
  const cached = keyByCwd.get(cwd)
  if (cached) return cached
  let key: string
  try {
    const toplevel = git(['rev-parse', '--show-toplevel'], cwd, { timeout: 5_000 })
    key = createHash('sha256').update(worktreeProjectRoot(toplevel)).digest('hex')
  } catch {
    key = createHash('sha256').update(cwd).digest('hex')
  }
  keyByCwd.set(cwd, key)
  return key
}

function normalizeRunCommand(value: unknown, index: number): RunCommandConfig | null {
  const raw = value as { id?: string; name?: string; command?: string; port?: unknown }
  const command = raw.command?.trim()
  if (!command) return null
  const entry: RunCommandConfig = {
    id: raw.id ? raw.id : `cmd-${index}`,
    command,
  }
  if (raw.name) entry.name = raw.name.trim()
  if (typeof raw.port === 'number' && Number.isFinite(raw.port)) entry.port = raw.port
  return entry
}

const TASK_PROVIDERS = new Set(['github', 'jira', 'linear', 'local'])

function normalizeConfig(value: unknown): ProjectConfig | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as {
    version?: unknown
    runCommands?: unknown
    taskProvider?: unknown
    taskProviderConfig?: unknown
  }
  const config: ProjectConfig = { version: 1 }
  if (Array.isArray(raw.runCommands)) {
    config.runCommands = raw.runCommands
      .map(normalizeRunCommand)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  }
  if (typeof raw.taskProvider === 'string' && TASK_PROVIDERS.has(raw.taskProvider)) {
    config.taskProvider = raw.taskProvider as ProjectConfig['taskProvider']
  }
  if (raw.taskProviderConfig && typeof raw.taskProviderConfig === 'object') {
    const scope = raw.taskProviderConfig as { owner?: unknown; repo?: unknown }
    const owner = typeof scope.owner === 'string' ? scope.owner : undefined
    const repo = typeof scope.repo === 'string' ? scope.repo : undefined
    if (owner || repo) config.taskProviderConfig = { owner, repo }
  }
  return config
}

export function projectConfigPath(cwd: string): string {
  const key = resolveProjectKey(cwd)
  return path.join(homedir(), '.solus', 'projects', key, 'project.json')
}

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig | null> {
  const raw = await readJsonOrNull(projectConfigPath(cwd))
  return raw === null ? null : normalizeConfig(raw)
}

export async function saveProjectConfig(cwd: string, config: ProjectConfig): Promise<ProjectConfig> {
  const normalized = normalizeConfig(config) ?? { version: 1 }
  await writeJson(projectConfigPath(cwd), normalized)
  return normalized
}
