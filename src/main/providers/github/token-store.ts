import { join } from 'path'
import { z } from 'zod'
import { createLogger } from '../../logger'
import { dataDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'

const log = createLogger('main', 'github-token-store')

const TOKEN_KEY = 'github-oauth'

/**
 * Persisted GitHub OAuth App user token. No `expiresAt`/`refreshToken`: OAuth
 * App user tokens are non-expiring by default. If we later enable expiring
 * tokens, add those fields plus a refresh path (mirroring google/oauth.ts).
 */
export interface GithubStoredToken {
  accessToken: string
  scope: string
  /** Cached from the first authenticated `/user` call so status() is offline-cheap. */
  login?: string
}

const githubStoredTokenSchema = z.object({
  accessToken: z.string(),
  scope: z.string(),
  login: z.string().optional(),
})

/** Raised when the OS keyring is unavailable; we never write a token in plaintext. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super('Secure storage is unavailable on this system, so the GitHub token cannot be saved safely.')
    this.name = 'EncryptionUnavailableError'
  }
}

function tokenFile(): string {
  return join(dataDir(), 'github-oauth.bin')
}

export function loadToken(): GithubStoredToken | null {
  return secretStore().loadJson(TOKEN_KEY, tokenFile(), githubStoredTokenSchema)
}

export function persistToken(token: GithubStoredToken): void {
  const store = secretStore()
  if (!store.canSave()) throw new EncryptionUnavailableError()
  store.saveJson(TOKEN_KEY, tokenFile(), token)
}

export function clearToken(): void {
  try {
    secretStore().remove(TOKEN_KEY, tokenFile())
  } catch (err) {
    log.warn('token_file_remove_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
