export function abbreviateHome(path: string | null | undefined): string {
  if (!path) return '~'
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

/**
 * Display name for a working directory: the friendly "My Workspace" label when
 * the path is the default workspace, otherwise the home-abbreviated path.
 */
export function displayDirName(
  path: string | null | undefined,
  workspacePath: string | null | undefined,
): string {
  if (path && workspacePath && path.replace(/\/+$/, '') === workspacePath.replace(/\/+$/, '')) {
    return 'My Workspace'
  }
  return abbreviateHome(path)
}
