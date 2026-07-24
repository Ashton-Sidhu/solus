export function abbreviateHome(path: string | null | undefined): string {
  if (!path) return '~'
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
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
