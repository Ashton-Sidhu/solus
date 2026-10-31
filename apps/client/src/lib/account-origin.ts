import { identityClaimsSchema, type AccountIdentity } from '@solus/contracts/auth/clients'
import { directoryResponseSchema, type DirectoryResponse } from '@solus/contracts/uplink'
import { z } from 'zod'

/**
 * What the account origin's shell says about itself (solus-cloud `renderClientShell`;
 * docs/plans/fast-secure-startup.md, decision 3): that this origin is the account
 * origin, and, signed in, who is signed in and their directory (instant-share-open.md
 * §4.14). A host serves the same bundle with none of them, so a page with no marker is
 * in local mode, and no request is spent to find out. The shell never carries a token.
 */
export interface AccountOriginShell {
  /** Who is signed in to the website; undefined when signed out (a guest on a share link) or it is not an identity. */
  signedIn: { identity: AccountIdentity; signedInAt: number } | undefined
  /** The signed-in person's directory, as `GET /v1/hosts` answers it; undefined when the
   *  page carries none (signed out, a share link, a failed read) or it is not a directory. */
  directory: DirectoryResponse | undefined
}

const signedInSchema = z.object({ identity: identityClaimsSchema, signedInAt: z.number() })

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
    signedIn: dataBlock(page, 'solus-account-identity', signedInSchema),
    directory: dataBlock(page, 'solus-host-directory', directoryResponseSchema),
  }
}
