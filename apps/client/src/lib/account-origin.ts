import { discoverySchema, type Discovery } from '@solus/client-core/oauth-session'

/**
 * What the account origin's shell says about itself (solus-cloud `serveClientShell`;
 * docs/plans/instant-share-open.md): that this origin is the account origin, and the
 * provider's OpenID metadata. A host serves the same bundle with neither, so a page
 * with no marker is in local mode, and no request is spent to find out.
 */
export interface AccountOriginShell {
  /** The provider's metadata as the shell carries it; undefined when it is missing or not metadata, and then read from the issuer. */
  discovery: Discovery | undefined
}

export function accountOriginShell(page: Pick<Document, 'querySelector'>): AccountOriginShell | null {
  if (!page.querySelector('meta[name="solus-account-origin"]')) return null
  const text = page.querySelector('script#solus-oidc-discovery')?.textContent
  try {
    const parsed = discoverySchema.safeParse(text ? JSON.parse(text) : null)
    return { discovery: parsed.success ? parsed.data : undefined }
  } catch {
    return { discovery: undefined }
  }
}
