import type { HostRoute } from '@solus/contracts/uplink'
import { SHARE_LINK_UNKNOWN, shareLinkTargetSchema, type ShareLinkTarget } from '@solus/contracts/sharing'
import { z } from 'zod'
import { dialableRoutes } from './server-registry'

/**
 * A share link names one resource (docs/plans/host-sharing.md). The secret alone
 * admits the visitor at the host that holds the resource; a browser keeps a visitor
 * identity so a returning guest keeps one name and color.
 */

const GUEST_KEY = 'solus.guest'

export interface GuestIdentity {
  guestId: string
  displayName: string
}

const guestIdentitySchema = z.object({
  guestId: z.string().regex(/^[a-zA-Z0-9_-]{16,64}$/),
  displayName: z.string().max(80),
})

export function loadGuestIdentity(): GuestIdentity | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY)
    if (!raw) return null
    const parsed = guestIdentitySchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function saveGuestIdentity(identity: GuestIdentity): void {
  localStorage.setItem(GUEST_KEY, JSON.stringify(identity))
}

/** A fresh guest id the cloud accepts: 24 URL-safe characters, made here so it is stable before the first grant. */
export function newGuestId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

/**
 * `POST /auth/share-link` (docs/plans/host-sharing.md §4.2): what the secret opens
 * and the host to dial first. Only the Solus API has this door, and its 404 for an
 * unknown secret names `SHARE_LINK_UNKNOWN`; a host answers the path with its own
 * unnamed 404, which is how a page learns a host serves it (`no-door`).
 * `unknown-link` is the API saying no such link, or not answering at all.
 */
const unknownLinkAnswerSchema = z.object({ error: z.object({ code: z.literal(SHARE_LINK_UNKNOWN) }) })

export type ShareLinkResolution =
  | { kind: 'resolved'; target: ShareLinkTarget }
  | { kind: 'unknown-link' }
  | { kind: 'no-door' }

export async function resolveShareLink(origin: string, secret: string, fetchImpl: typeof fetch = fetch): Promise<ShareLinkResolution> {
  try {
    const response = await fetchImpl(`${origin}/auth/share-link`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ shareSecret: secret }),
      signal: AbortSignal.timeout(8_000),
    })
    const body: unknown = await response.json().catch(() => null)
    if (response.status === 404) return unknownLinkAnswerSchema.safeParse(body).success ? { kind: 'unknown-link' } : { kind: 'no-door' }
    if (!response.ok) return { kind: 'unknown-link' }
    const parsed = shareLinkTargetSchema.safeParse(body)
    return parsed.success ? { kind: 'resolved', target: parsed.data } : { kind: 'unknown-link' }
  } catch {
    return { kind: 'unknown-link' }
  }
}

/** The route a guest dials: the first the page can open, tunnel included. */
export function guestRouteUrl(routes: HostRoute[], clientOrigin: string): string | null {
  return dialableRoutes(routes, clientOrigin)[0]?.url ?? null
}
