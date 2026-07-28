/** Scopes GitHub CLI validates before accepting a token via `--with-token`. */
export const GITHUB_CLI_REQUIRED_SCOPES = ['repo', 'read:org', 'gist'] as const

/** Solus also needs Projects v2 access for task due dates, priorities, and status. */
export const GITHUB_OAUTH_SCOPES = [...GITHUB_CLI_REQUIRED_SCOPES, 'project'] as const

/** GitHub returns scopes comma-separated, while older stored tokens may use spaces. */
export function parseGithubScopes(scope: string | undefined): string[] {
  return scope ? scope.split(/[,\s]+/).filter(Boolean) : []
}

export function hasGithubCliScopes(scopes: readonly string[] | undefined): boolean {
  return !!scopes && GITHUB_CLI_REQUIRED_SCOPES.every((scope) => scopes.includes(scope))
}
