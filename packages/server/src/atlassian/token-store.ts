import { join } from 'path'
import { z } from 'zod'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import { EncryptionUnavailableError } from '../providers/github/token-store'

const log = createLogger('main', 'atlassian-token-store')

const TOKEN_KEY = 'atlassian-oauth'

/**
 * One account, one site, one grant approved in a browser.
 *
 * `cloudId` is the site identity rather than the hostname: an OAuth token is
 * spent against `api.atlassian.com/ex/<product>/<cloudId>`, and every external
 * key persisted later is built from it, so a renamed site keeps working.
 */
export interface AtlassianStoredCredential {
  siteUrl: string
  cloudId: string
  siteName?: string
  products: Array<'confluence' | 'jira'>
  accessToken: string
  /** Atlassian rotates this on every use; the new one must replace the old or
   *  the grant is lost. */
  refreshToken: string
  expiresAt: number
  scopes: string[]
}

const atlassianStoredCredentialSchema = z.object({
  siteUrl: z.string(),
  cloudId: z.string(),
  siteName: z.string().optional(),
  products: z.array(z.enum(['confluence', 'jira'])),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
})

function tokenFile(): string {
  return join(dataDir(), 'atlassian-oauth.bin')
}

export function loadCredential(): AtlassianStoredCredential | null {
  return secretStore().loadJson(TOKEN_KEY, tokenFile(), atlassianStoredCredentialSchema)
}

export function persistCredential(credential: AtlassianStoredCredential): void {
  const store = secretStore()
  if (!store.canSave()) throw new EncryptionUnavailableError()
  store.saveJson(TOKEN_KEY, tokenFile(), credential)
}

export function clearCredential(): void {
  try {
    secretStore().remove(TOKEN_KEY, tokenFile())
  } catch (err) {
    log.warn('token_file_remove_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

// Consumers load through `currentCredential()` in oauth.ts, which refreshes
// first. api.ts owns the authorization header and product REST base.
