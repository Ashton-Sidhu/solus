import { discoverySchema, type Discovery } from '@solus/client-core/oauth-session'
import { directoryResponseSchema, type DirectoryResponse } from '@solus/contracts/uplink'
import type { z } from 'zod'

/**
 * What the account origin's shell says about itself (solus-cloud `serveClientShell`;
 * docs/plans/instant-share-open.md): that this origin is the account origin, the
 * provider's OpenID metadata, and, signed in, the person's directory (§4.14). A host
 * serves the same bundle with none of them, so a page with no marker is in local
 * mode, and no request is spent to find out.
 */
export interface AccountOriginShell {
  /** The provider's metadata as the shell carries it; undefined when it is missing or not metadata, and then read from the issuer. */
  discovery: Discovery | undefined
  /** The signed-in person's directory, as `GET /v1/hosts` answers it; undefined when the
   *  page carries none (signed out, a share link, a failed read) or it is not a directory. */
  directory: DirectoryResponse | undefined
}

/** A JSON data block of the shell, parsed with `schema`; undefined when it is missing or does not match. */
function dataBlock<T>(page: Pick<Document, 'querySelector'>, id: string, schema: z.ZodType<T>): T | undefined {
  const text = page.querySelector(`script#${id}`)?.textContent
  try {
    const parsed = schema.safeParse(text ? JSON.parse(text) : null)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function accountOriginShell(page: Pick<Document, 'querySelector'>): AccountOriginShell | null {
  if (!page.querySelector('meta[name="solus-account-origin"]')) return null
  return {
    discovery: dataBlock(page, 'solus-oidc-discovery', discoverySchema),
    directory: dataBlock(page, 'solus-host-directory', directoryResponseSchema),
  }
}
