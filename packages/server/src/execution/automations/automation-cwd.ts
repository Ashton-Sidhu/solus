import { projectRootOfPath } from '../../git/task-folder-store'
import { resolveProjectRoot } from '../../project-config/project-config'

/** Preserve a directory the user supplied. Only the implicit default is the
 * active session's canonical project root. */
export function resolveAutomationCwd(
  explicitCwd: string | undefined,
  activeCwd: string | undefined,
): string {
  if (explicitCwd?.trim()) return explicitCwd
  return resolveProjectRoot(projectRootOfPath(activeCwd ?? '~'))
}
