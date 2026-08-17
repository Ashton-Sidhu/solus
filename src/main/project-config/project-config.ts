import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ProjectConfig } from '../../shared/types'
import { worktreeProjectRoot } from '../../shared/types'
import { getDb } from '../db'
import { git } from '../git/exec'

const keyByCwd = new Map<string, string>()

const projectConfigRowSchema = z.object({ config: z.string() })

const projectConfigInputSchema = z.object({
  taskProvider: z.enum(['github', 'local']).optional(),
  taskProviderConfig: z.object({
    owner: z.string().optional(),
    repo: z.string().optional(),
  }).optional(),
  tasksAutoPushComments: z.boolean().optional(),
  taskDoneOnMerge: z.boolean().optional(),
})

type ProjectConfigInput = z.infer<typeof projectConfigInputSchema>

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

function normalizeConfig(raw: ProjectConfigInput): ProjectConfig {
  const config: ProjectConfig = { version: 1 }
  if (raw.taskProvider !== undefined) {
    config.taskProvider = raw.taskProvider
  }
  if (raw.taskProviderConfig?.owner || raw.taskProviderConfig?.repo) {
    config.taskProviderConfig = {}
    if (raw.taskProviderConfig.owner !== undefined) {
      config.taskProviderConfig.owner = raw.taskProviderConfig.owner
    }
    if (raw.taskProviderConfig.repo !== undefined) {
      config.taskProviderConfig.repo = raw.taskProviderConfig.repo
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

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig | null> {
  const rowResult = projectConfigRowSchema.safeParse(getDb().prepare(
    'SELECT config FROM project_config WHERE project_key = ?',
  ).get(resolveProjectKey(cwd)))
  if (!rowResult.success) return null
  const configResult = projectConfigInputSchema.safeParse(JSON.parse(rowResult.data.config))
  return configResult.success ? normalizeConfig(configResult.data) : null
}

export async function saveProjectConfig(cwd: string, config: ProjectConfig): Promise<ProjectConfig> {
  const normalized = normalizeConfig(projectConfigInputSchema.parse(config))
  getDb().prepare(`
    INSERT INTO project_config (project_key, config, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      config = excluded.config,
      updated_at = excluded.updated_at
  `).run(resolveProjectKey(cwd), JSON.stringify(normalized), Date.now())
  return normalized
}
