export function abbreviateHome(path: string | null | undefined): string {
  if (!path) return '~'
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

/**
 * Elides the middle of a long path so both the root and the folder name survive
 * — the two halves that identify it. Abbreviate the home prefix first; this only
 * decides what to drop from whatever it is handed.
 */
export function truncateMiddle(value: string, maxLength = 48): string {
  if (value.length <= maxLength) return value
  // The tail is what the user is actually looking at, so it keeps the larger share.
  const tail = Math.max(1, Math.floor((maxLength - 1) * 0.6))
  const head = Math.max(1, maxLength - 1 - tail)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

/** True when a working directory is the default "My Workspace" directory. */
export function isWorkspaceDir(
  path: string | null | undefined,
  workspacePath: string | null | undefined,
): boolean {
  if (!path || !workspacePath) return false
  return path.replace(/\/+$/, '') === workspacePath.replace(/\/+$/, '')
}

/**
 * Display name for a working directory: the friendly "My Workspace" label when
 * the path is the default workspace, otherwise the home-abbreviated path.
 */
export function displayDirName(
  path: string | null | undefined,
  workspacePath: string | null | undefined,
): string {
  if (isWorkspaceDir(path, workspacePath)) return 'My Workspace'
  return abbreviateHome(path)
}

/**
 * The project's own name — its last path segment. Companion to
 * `displayDirName` for rows too narrow for a path, where the folder name is
 * the only part a reader identifies the project by.
 */
export function projectDirLabel(
  path: string | null | undefined,
  workspacePath: string | null | undefined,
): string {
  if (isWorkspaceDir(path, workspacePath)) return 'My Workspace'
  const dir = path?.replace(/\/+$/, '')
  if (!dir || dir === '~') return '~'
  return dir.split('/').pop() || abbreviateHome(dir)
}
