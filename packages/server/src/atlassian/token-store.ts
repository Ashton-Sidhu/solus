import { z } from 'zod'
import { clearProviderCredential, readProviderCredential, writeProviderCredential } from '../vault/provider-credentials'

/**
 * One account, one site, one grant approved in a browser.
 *
 * `cloudId` is the site identity rather than the hostname: an OAuth token is
 * spent against `api.atlassian.com/ex/<product>/<cloudId>`, and every external
 * key persisted later is built from it, so a renamed site keeps working.
 *
 * Where it lives — the host's secret store, the scoped person's vault row, or a
 * runner's lease — is `provider-credentials`' choice (cloud-service-model.md §22).
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

export function loadCredential(): Promise<AtlassianStoredCredential | null> {
  return readProviderCredential('atlassian', atlassianStoredCredentialSchema)
}

export function persistCredential(credential: AtlassianStoredCredential): Promise<void> {
  return writeProviderCredential('atlassian', credential)
}

export function clearCredential(): Promise<void> {
  return clearProviderCredential('atlassian')
}

// Consumers load through `currentCredential()` in oauth.ts, which refreshes
// first. api.ts owns the authorization header and product REST base.
