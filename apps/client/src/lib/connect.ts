// Relative (not @client-core) so bun's test runner can resolve it too.
import { normalizeServerUrl, parsePairLink } from '@solus/client-core/pairing'
import { z } from 'zod'
import type { HostOperatingSystem } from '@solus/contracts/types'

/**
 * The connect form takes one smart field: a full pairing link pairs directly,
 * anything else is treated as a server address that still needs its code.
 */
export type ConnectInput =
  | { kind: 'link'; url: string; pairToken: string }
  | { kind: 'address'; url: string }
  | { kind: 'empty' }

export function classifyConnectInput(raw: string): ConnectInput {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'empty' }
  const link = parsePairLink(trimmed)
  if (link) return { kind: 'link', url: link.url, pairToken: link.pairToken }
  return { kind: 'address', url: normalizeServerUrl(trimmed) }
}

/**
 * A pairing QR encodes `http://host:port/pair#token=…`. Opening it in a browser
 * lands on the server's own SPA at `/pair`, so the token in the fragment is the
 * whole handshake — scan, open, paired. `base` is where the client is mounted:
 * `/` on a host, `/app/` on the account origin.
 */
export function pairTokenFromLocation(href: string, base = '/'): string | null {
  try {
    const url = new URL(href)
    if (url.pathname !== `${base}pair`) return null
    return new URLSearchParams(url.hash.replace(/^#/, '')).get('token')
  } catch {
    return null
  }
}

export interface ProbedServer {
  ok: boolean
  name?: string
  /** False when the server accepts connections without pairing (loopback or
   *  proxied binds) — the served client can then connect with no ceremony. */
  requireAuth?: boolean
  /** Identifies the host across every address it answers on. */
  installationId?: string
  os?: HostOperatingSystem
}

/** One /health dial with a timeout — no registry, usable before a server is saved. */
export async function probeServer(url: string, timeoutMs = 3_000): Promise<ProbedServer> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false }
    // Forward-compatible: one reshaped field from a newer server degrades to
    // "absent" instead of failing the probe — a full probe failure here breaks
    // zero-ceremony boot.
    const body = z.object({
      ok: z.boolean().optional().catch(undefined),
      name: z.string().optional().catch(undefined),
      requireAuth: z.boolean().optional().catch(undefined),
      installationId: z.string().optional().catch(undefined),
      os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
    }).catch({}).parse(await response.json())
    return {
      ok: body.ok === true,
      name: body.name,
      requireAuth: body.requireAuth,
      installationId: body.installationId,
      os: body.os,
    }
  } catch {
    return { ok: false }
  }
}
