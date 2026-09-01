/**
 * `drive.file` writes the docs Solus creates. `drive.readonly` is the only way
 * to search or read a doc Solus did not create, so both are asked for together.
 */
export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const GOOGLE_DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
export const GOOGLE_OAUTH_SCOPES = [GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE] as const

/** What the host knows about the Google connection. `scopes` is what Google
 *  granted, never what Solus asked for, so a client can detect a grant narrower
 *  than this build needs and offer a reconnect. */
export interface GoogleAuthStatus {
  connected: boolean
  /** False when the build ships no Google OAuth client, so no sign-in exists. */
  configured: boolean
  scopes?: string[]
}

/** Google returns granted scopes space-separated. */
export function parseGoogleScopes(scope: string | undefined | null): string[] {
  return scope ? scope.split(/\s+/).filter(Boolean) : []
}

/**
 * The required scopes a grant does not hold. Google never widens an existing
 * grant on its own, so a non-empty answer means the user has to sign in again —
 * the same drift a GitHub token minted before the `project` scope shows.
 */
export function missingGoogleScopes(granted: readonly string[] | undefined): string[] {
  const held = new Set(granted ?? [])
  return GOOGLE_OAUTH_SCOPES.filter((scope) => !held.has(scope))
}

/** Whether the grant can reach documents Solus did not create. */
export function hasGoogleDriveReadScope(granted: readonly string[] | undefined): boolean {
  return !!granted?.includes(GOOGLE_DRIVE_READONLY_SCOPE)
}
