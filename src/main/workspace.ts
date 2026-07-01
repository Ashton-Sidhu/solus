import { homedir } from 'os'
import { join, sep } from 'path'

/** The user's general-purpose workspace — the app's default working directory. */
export const WORKSPACE_DIR = join(homedir(), '.solus', 'my-workspace')

/** True when a working directory is the workspace root or any folder nested under it. */
export function isWorkspacePath(cwd: string | null | undefined): boolean {
  if (!cwd) return false
  const normalized = cwd.replace(/[/\\]+$/, '')
  return normalized === WORKSPACE_DIR || normalized.startsWith(WORKSPACE_DIR + sep)
}
