import { createHash } from 'node:crypto'
import type { ProjectConfig } from '../../shared/types'
import { worktreeProjectRoot } from '../../shared/types'
import { getDb } from '../db'
import { git } from '../git/exec'

const keyByCwd = new Map<string, string>()

interface ProjectConfigRow {
  config: string
}

/**
 * Stable key for a project, used to co-locate per-project data on disk.
 * Memoized — the repo toplevel for a cwd is stable for the
 * process lifetime and the sync git spawn would otherwise block the main
 * process on every config/recents call.
 *
 * For Solus worktrees, the marker is stripped so all worktrees of the same
 * base repo share a single config.
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

const TASK_PROVIDERS = new Set(['github', 'local'])

function normalizeConfig(value: unknown): ProjectConfig | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as {
    version?: unknown
    taskProvider?: unknown
    taskProviderConfig?: unknown
  }
  const config: ProjectConfig = { version: 1 }
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

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig | null> {
  const row = getDb().prepare(
    'SELECT config FROM project_config WHERE project_key = ?',
  ).get(resolveProjectKey(cwd)) as ProjectConfigRow | undefined
  return row ? normalizeConfig(JSON.parse(row.config)) : null
}

export async function saveProjectConfig(cwd: string, config: ProjectConfig): Promise<ProjectConfig> {
  const normalized = normalizeConfig(config) ?? { version: 1 }
  getDb().prepare(`
    INSERT INTO project_config (project_key, config, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      config = excluded.config,
      updated_at = excluded.updated_at
  `).run(resolveProjectKey(cwd), JSON.stringify(normalized), Date.now())
  return normalized
}
