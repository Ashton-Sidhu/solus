import { z } from 'zod'
import { normalizeServerUrl, parsePairLink, urlHost } from '@solus/client-core/pairing'
import { failureText, unreachableCause, type UnreachableCause } from '@solus/client-core/host-unreachable'
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
  /** The host trusts this device by network position, so it pairs without a code. */
  trusted: boolean
  /** Discovery found the host on the tailnet: pairing saves its address as a `tailnet` route (docs/plans/tailscale-support.md D8). */
  onTailnet?: boolean
}

const healthSchema = z.object({
  ok: z.literal(true),
  installationId: z.string().min(1),
  name: z.string().min(1),
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
  requireAuth: z.boolean().optional().catch(undefined),
})

export type PreviewResult =
  | { kind: 'found'; preview: HostPreview }
  | { kind: 'not-solus' }
  /** `error` is the platform's own text, shown when the cause names nothing better. */
  | { kind: 'unreachable'; cause: UnreachableCause; error: string }

/** One `/health` read: the target the user confirms before pairing. */
export async function previewHost(fetchImpl: typeof fetch, url: string, timeoutMs = 5_000): Promise<PreviewResult> {
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(`${url}/health`, { signal })
  } catch (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure))
    return { kind: 'unreachable', cause: unreachableCause(error, signal.aborted), error: failureText(error) }
  }
  if (!response.ok) return { kind: 'not-solus' }
  const body = healthSchema.safeParse(await response.json().catch(() => null))
  if (!body.success) return { kind: 'not-solus' }
  return {
    kind: 'found',
    preview: { url, host: urlHost(url), name: body.data.name, installationId: body.data.installationId, os: body.data.os, trusted: body.data.requireAuth === false },
  }
}

/** What the add-host screen says when an address did not answer; `detail` is the error text, in small type. */
export interface UnreachableMessage {
  message: string
  detail: string | null
}

export function unreachableMessage(result: Extract<PreviewResult, { kind: 'unreachable' }>): UnreachableMessage {
  switch (result.cause) {
    case 'insecure-blocked':
      return { message: 'This app blocked a plain-HTTP connection to this address. Update Solus, or use an HTTPS address.', detail: null }
    case 'timeout':
      return { message: 'The host did not answer in time. Check that Tailscale or your Wi-Fi is on, on this device and on the host.', detail: null }
    case 'refused':
      return { message: 'Nothing listens at this address and port. Check the port; a Solus host often uses 3000.', detail: null }
    case 'other':
      return {
        message: 'The host did not answer. Check the address and that this device is on a network that can reach it.',
        detail: result.error || null,
      }
  }
}

/** The user-facing reason a `/pair` exchange failed. */
export function pairFailureMessage(error: Error): string {
  if (/expired|invalid/i.test(error.message)) return 'This pairing code is not valid or has expired. Ask the host for a new code.'
  if (/too many/i.test(error.message)) return 'Too many pairing attempts. Wait a minute and try again.'
  if (/network|fetch|failed to connect|timed? ?out/i.test(error.message)) return 'The host did not answer. Check that this device can reach it.'
  return error.message
}
