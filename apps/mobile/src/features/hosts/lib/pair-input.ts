import { z } from 'zod'
import { normalizeServerUrl, parsePairLink, urlHost } from '@solus/client-core/pairing'
import type { HostOperatingSystem } from '@solus/contracts/types'

/**
 * What the user gave us to reach a host: a scanned pairing QR code or a pasted
 * pairing link (`http://host:port/pair#token=…`), or an address with the
 * six-character code the host shows. The QR code encodes the same link.
 */
export type PairInput =
  | { kind: 'link'; url: string; pairToken: string }
  | { kind: 'address'; url: string; pairToken: string | null }
  | { kind: 'invalid'; message: string }

export function decodePairInput(address: string, code = ''): PairInput {
  const trimmed = address.trim()
  if (!trimmed) return { kind: 'invalid', message: 'Enter the host address or scan its pairing code.' }
  const link = parsePairLink(trimmed)
  if (link) return { kind: 'link', url: link.url, pairToken: link.pairToken }
  // A scanned code that is a URL but carries no token is a host page, not a pairing code.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return { kind: 'invalid', message: 'This is not a Solus pairing code.' }
  }
  const url = normalizeServerUrl(trimmed)
  try {
    new URL(url)
  } catch {
    return { kind: 'invalid', message: 'This address is not valid.' }
  }
  const pairToken = code.trim()
  return { kind: 'address', url, pairToken: pairToken || null }
}

/** A scanned QR payload must be a pairing link; an address alone is not enough. */
export function decodeScannedCode(data: string): PairInput {
  const decoded = decodePairInput(data)
  if (decoded.kind === 'address') return { kind: 'invalid', message: 'This QR code is not a Solus pairing code.' }
  return decoded
}

export interface HostPreview {
  url: string
  host: string
  name: string
  installationId: string
  os?: HostOperatingSystem
}

const healthSchema = z.object({
  ok: z.literal(true),
  installationId: z.string().min(1),
  name: z.string().min(1),
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
})

export type PreviewResult =
  | { kind: 'found'; preview: HostPreview }
  | { kind: 'not-solus' }
  | { kind: 'unreachable' }

/** One `/health` read: the target the user confirms before pairing. */
export async function previewHost(fetchImpl: typeof fetch, url: string, timeoutMs = 5_000): Promise<PreviewResult> {
  let response: Response
  try {
    response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { kind: 'unreachable' }
  }
  if (!response.ok) return { kind: 'not-solus' }
  const body = healthSchema.safeParse(await response.json().catch(() => null))
  if (!body.success) return { kind: 'not-solus' }
  return {
    kind: 'found',
    preview: { url, host: urlHost(url), name: body.data.name, installationId: body.data.installationId, os: body.data.os },
  }
}

/** The user-facing reason a `/pair` exchange failed. */
export function pairFailureMessage(error: Error): string {
  if (/expired|invalid/i.test(error.message)) return 'This pairing code is not valid or has expired. Ask the host for a new code.'
  if (/too many/i.test(error.message)) return 'Too many pairing attempts. Wait a minute and try again.'
  if (/network|fetch|failed to connect|timed? ?out/i.test(error.message)) return 'The host did not answer. Check that this device can reach it.'
  return error.message
}
