export type PrSurfaceError = {
  kind: 'github-auth' | 'no-repository' | 'generic'
  message: string
}

const GITHUB_AUTH_MESSAGES = [
  'GitHub is not connected',
  'Your GitHub authorization is no longer valid. Reconnect GitHub to continue.',
]

/** The server's answer for a folder with no `origin` remote — My Workspace, a
 *  plain directory, a repository that was never pushed. Not a failure: such a
 *  project has no pull requests to load, so no surface reports it as one. */
const NO_REPOSITORY_MESSAGE = 'no recognizable git remote'

export function prSurfaceError(error: Parameters<typeof String>[0]): PrSurfaceError {
  const message = error instanceof Error ? error.message : String(error)
  return { kind: errorKind(message), message }
}

function errorKind(message: string): PrSurfaceError['kind'] {
  if (GITHUB_AUTH_MESSAGES.some((candidate) => message.includes(candidate))) return 'github-auth'
  if (message.includes(NO_REPOSITORY_MESSAGE)) return 'no-repository'
  return 'generic'
}
