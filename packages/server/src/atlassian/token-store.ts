import { z } from 'zod'
import { currentPersonKey } from '../vault/acting-scope'
import { vault } from '../vault/vault'
import type { ProviderRef } from '@solus/contracts/vault'

/**
 * One account, one site, one grant approved in a browser.
 *
 * `cloudId` is the site identity rather than the hostname: an OAuth token is
 * spent against `api.atlassian.com/ex/<product>/<cloudId>`, and every external
 * key persisted later is built from it, so a renamed site keeps working.
 *
 * Where it lives — the host's secret store, the scoped person's vault row, or a
 * runner's lease — is the vault's choice (docs/plans/access-model.md §2.6).
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

const ATLASSIAN: ProviderRef = { kind: 'provider', provider: 'atlassian' }

export function loadCredential(): Promise<AtlassianStoredCredential | null> {
  return vault().read(currentPersonKey(), ATLASSIAN, atlassianStoredCredentialSchema)
}

export async function persistCredential(credential: AtlassianStoredCredential): Promise<void> {
  vault().save(currentPersonKey(), ATLASSIAN, credential)
}

export async function clearCredential(): Promise<void> {
  vault().remove(currentPersonKey(), ATLASSIAN)
}

// Consumers load through `currentCredential()` in oauth.ts, which refreshes
// first. api.ts owns the authorization header and product REST base.
