import { z } from 'zod'
import { currentPersonKey } from '../../vault/acting-scope'
import { vault } from '../../vault/vault'
import type { ProviderRef } from '@solus/contracts/vault'

/**
 * Persisted GitHub OAuth App user token. No `expiresAt`/`refreshToken`: OAuth
 * App user tokens are non-expiring by default. If we later enable expiring
 * tokens, add those fields plus a refresh path (mirroring google/oauth.ts).
 *
 * Where it lives — the host's secret store, the scoped person's vault row, or a
 * runner's lease — is the vault's choice (docs/plans/access-model.md §2.6).
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

export { EncryptionUnavailableError } from '../../vault/vault'

const GITHUB: ProviderRef = { kind: 'provider', provider: 'github' }

export function loadToken(): Promise<GithubStoredToken | null> {
  return vault().read(currentPersonKey(), GITHUB, githubStoredTokenSchema)
}

export async function persistToken(token: GithubStoredToken): Promise<void> {
  vault().save(currentPersonKey(), GITHUB, token)
}

export async function clearToken(): Promise<void> {
  vault().remove(currentPersonKey(), GITHUB)
}
