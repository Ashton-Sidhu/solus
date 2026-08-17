export type PrSurfaceError = {
  kind: 'github-auth' | 'generic'
  message: string
}

const GITHUB_AUTH_MESSAGES = [
  'GitHub is not connected',
  'Your GitHub authorization is no longer valid. Reconnect GitHub to continue.',
]

export function prSurfaceError(error: Parameters<typeof String>[0]): PrSurfaceError {
  const message = error instanceof Error ? error.message : String(error)
  return {
    kind: GITHUB_AUTH_MESSAGES.some((candidate) => message.includes(candidate))
      ? 'github-auth'
      : 'generic',
    message,
  }
}
