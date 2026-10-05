import {
  slugifyBranchTitle,
  worktreeBranchNamingSchema,
  worktreeBranchTemplate,
  type WorktreeBranchNamer,
  type WorktreeBranchNaming,
} from '@solus/contracts/worktree-branch-naming'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { loadProjectConfig } from '../project-config/project-config'
import { runAsync } from './exec'

/**
 * The naming for a new worktree: the project's `.solus/config.json` override,
 * else the person's own preference, else the built-in default (plans/018 §3.3).
 * `cwd` may be the repository or one of its worktrees.
 */
export async function resolveWorktreeBranchNamer(cwd: string, personal: WorktreeBranchNaming | undefined): Promise<WorktreeBranchNamer> {
  const naming = (await loadProjectConfig(cwd))?.worktreeBranchNaming ?? personal ?? DEFAULT_EXECUTION_PREFERENCES.worktreeBranchNaming
  return namerFor(cwd, naming)
}

/** The git user is read only when the template asks for `{user}`. */
async function namerFor(cwd: string, naming: WorktreeBranchNaming): Promise<WorktreeBranchNamer> {
  if (!worktreeBranchTemplate(naming).includes('{user}')) return { naming, user: null }
  const name = await runAsync('git', ['config', 'user.name'], cwd).catch(() => '')
  return { naming, user: slugifyBranchTitle(name) || null }
}

/** Kept in the branch's own git config, which `git branch -m` carries with the branch. */
const namingConfigKey = (branch: string) => `branch.${branch}.solusNaming`

/**
 * Records the naming a worktree was created with, so the later rename from its
 * title uses the same naming even after the person or the project changes theirs.
 */
export async function captureWorktreeBranchNaming(cwd: string, branch: string, naming: WorktreeBranchNaming): Promise<void> {
  await runAsync('git', ['config', namingConfigKey(branch), JSON.stringify(naming)], cwd)
}

/** The naming captured for `branch` at its creation; null for a worktree made before captures. */
export async function capturedWorktreeBranchNamer(cwd: string, branch: string): Promise<WorktreeBranchNamer | null> {
  const stored = await runAsync('git', ['config', '--get', namingConfigKey(branch)], cwd).catch(() => '')
  if (!stored) return null
  let decoded: unknown
  try { decoded = JSON.parse(stored) } catch { return null }
  const parsed = worktreeBranchNamingSchema.safeParse(decoded)
  return parsed.success ? namerFor(cwd, parsed.data) : null
}
