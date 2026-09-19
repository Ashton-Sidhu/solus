import { z } from 'zod'
import { clearProviderCredential, readProviderCredential, writeProviderCredential } from '../../vault/provider-credentials'

/**
 * Persisted GitHub OAuth App user token. No `expiresAt`/`refreshToken`: OAuth
 * App user tokens are non-expiring by default. If we later enable expiring
 * tokens, add those fields plus a refresh path (mirroring google/oauth.ts).
 *
 * Where it lives — the host's secret store, the scoped person's vault row, or a
 * runner's lease — is `provider-credentials`' choice (cloud-service-model.md §22).
 */
export interface GithubStoredToken {
  accessToken: string
  scope: string
  /** Cached from the first authenticated `/user` call so status() is offline-cheap. */
  login?: string
}

export const githubStoredTokenSchema = z.object({
  accessToken: z.string(),
  scope: z.string(),
  login: z.string().optional(),
})

export { EncryptionUnavailableError } from '../../vault/provider-credentials'

export function loadToken(): Promise<GithubStoredToken | null> {
  return readProviderCredential('github', githubStoredTokenSchema)
}

export function persistToken(token: GithubStoredToken): Promise<void> {
  return writeProviderCredential('github', token)
}

export function clearToken(): Promise<void> {
  return clearProviderCredential('github')
}
