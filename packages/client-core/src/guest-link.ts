import { guestGrantResponseSchema, type GuestGrantResponse, type HostRoute } from '@solus/contracts/uplink'
import { z } from 'zod'
import { dialableRoutes } from './server-registry'

/**
 * A cloud share link names one resource. The account origin issues a short grant;
 * only the workspace service receives and resolves its secret. A browser keeps
 * a visitor identity for anonymous returns. A valid account session supplies the
 * verified identity when the account server mints the grant.
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

/** `POST /v1/workspace/guest-grant` on the account origin; null when it refused or did not answer. */
export async function mintGuestGrant(
  origin: string,
  identity: GuestIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<GuestGrantResponse | null> {
  try {
    const response = await fetchImpl(`${origin}/v1/workspace/guest-grant`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ guestId: identity.guestId, displayName: identity.displayName }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return null
    const parsed = guestGrantResponseSchema.safeParse(await response.json().catch(() => null))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The route a guest dials: the first the page can open, tunnel included. */
export function guestRouteUrl(routes: HostRoute[], clientOrigin: string): string | null {
  return dialableRoutes(routes, clientOrigin)[0]?.url ?? null
}
