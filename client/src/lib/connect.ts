// Relative (not @client-core) so bun's test runner can resolve it too.
import { normalizeServerUrl, parsePairLink } from '../../../src/client-core/pairing'
import { z } from 'zod'
import type { HostOperatingSystem } from '../../../src/shared/types'

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
 * whole handshake — scan, open, paired.
 */
export function pairTokenFromLocation(href: string): string | null {
  try {
    const url = new URL(href)
    if (url.pathname !== '/pair') return null
    return new URLSearchParams(url.hash.replace(/^#/, '')).get('token')
  } catch {
    return null
  }
}

export interface ProbedServer {
  ok: boolean
  name?: string
  claimable?: boolean
  /** Identifies the host across every address it answers on. */
  installationId?: string
  os?: HostOperatingSystem
}

/** One /health dial with a timeout — no registry, usable before a server is saved. */
export async function probeServer(url: string, timeoutMs = 3_000): Promise<ProbedServer> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false }
    const body = z.object({
      ok: z.boolean().optional(),
      name: z.string().optional(),
      claimable: z.boolean().optional(),
      installationId: z.string().optional(),
      os: z.enum(['macos', 'windows', 'linux']).optional(),
    }).parse(await response.json())
    return {
      ok: body.ok === true,
      name: body.name,
      claimable: body.claimable,
      installationId: body.installationId,
      os: body.os,
    }
  } catch {
    return { ok: false }
  }
}
