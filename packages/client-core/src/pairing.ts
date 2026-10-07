import { z } from 'zod'
import type { SavedServer } from './server-registry'
import { DEFAULT_SERVER_PORT, type HostOperatingSystem, type SshBootstrapCredential } from '@solus/contracts/types'

// Handshake decoding is forward-compatible: a field a newer server reshapes
// (an unknown `os`, a structured error) degrades to "absent" instead of
// failing the response — a decode error here would block pairing entirely.
const tolerantString = z.string().optional().catch(undefined)
const tolerantOs = z.enum(['macos', 'windows', 'linux']).optional().catch(undefined)
const serverErrorSchema = z.object({ error: tolerantString }).catch({})
const pairResponseSchema = z.object({
  sessionToken: tolerantString,
  installationId: tolerantString,
  os: tolerantOs,
}).catch({})

export interface ParsedPairLink {
  url: string
  pairToken: string
}

export interface PairServerInput {
  url: string
  pairToken: string
  /** What this device calls itself. Each client names itself: a browser with
   *  `defaultDeviceLabel()` (`device-label.ts`), the native app by its device. */
  deviceLabel: string
  /** Only what the user typed. The caller must not pre-fill a fallback here:
   *  a derived name saved as the user's would then outrank the name the host
   *  advertises once it connects. */
  serverLabel?: string
  /** What the host called itself on the probe that preceded pairing, used when
   *  the user named nothing. Absent when the host was never asked. */
  reportedName?: string
  /** The client's own fetch; the global one when absent. */
  fetchImpl?: typeof fetch
}

export interface PairServerResult {
  server: SavedServer
  sessionToken: string
  installationId: string
}

/** An address a host listens on, as `connectionsListEndpoints` answers it. */
export interface PairEndpoint {
  kind: 'loopback' | 'lan' | 'tailnet'
  host: string
  port: number
}

const ENDPOINT_REACH = { tailnet: 0, lan: 1, loopback: 2 } satisfies Record<PairEndpoint['kind'], number>

/** The address worth handing to another device: the widest reach first; loopback only when there is nothing else. */
export function bestPairEndpoint<E extends PairEndpoint>(endpoints: readonly E[]): E | null {
  return [...endpoints].sort((a, b) => ENDPOINT_REACH[a.kind] - ENDPOINT_REACH[b.kind])[0] ?? null
}

/** The link another device opens or scans to pair; `parsePairLink` reads it back. */
export function pairLink(endpoint: PairEndpoint, pairToken: string): string {
  return `http://${endpoint.host}:${endpoint.port}/pair#token=${pairToken}`
}

export function parsePairLink(link: string): ParsedPairLink | null {
  try {
    const u = new URL(link.trim())
    const fragment = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash
    const params = new URLSearchParams(fragment)
    const pairToken = params.get('token')
    if (!pairToken) return null
    return { url: `${u.protocol}//${u.host}`, pairToken }
  } catch {
    return null
  }
}

/**
 * A typed address becomes the URL the client dials. An explicit scheme is left
 * exactly as written — `https://solus.example.com` means the proxy on 443. A
 * bare address is already a guess (we assume http), so it guesses the port too:
 * `10.10.1.219` means the Solus server, never a web server on port 80.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  try {
    const url = new URL(`http://${trimmed}`)
    if (!url.port) url.port = String(DEFAULT_SERVER_PORT)
    return url.toString().replace(/\/+$/, '')
  } catch {
    return `http://${trimmed}`
  }
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export async function pairServer(input: PairServerInput): Promise<PairServerResult> {
  const url = normalizeServerUrl(input.url)
  const res = await (input.fetchImpl ?? fetch)(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairToken: input.pairToken,
      deviceLabel: input.deviceLabel,
    }),
  })
  if (!res.ok) {
    const body = serverErrorSchema.parse(await res.json().catch(() => ({})))
    throw new Error(body.error ?? `Pair failed (${res.status})`)
  }

  const body = pairResponseSchema.parse(await res.json().catch(() => ({})))
  if (!body.sessionToken) throw new Error('Pair response did not include a session token')
  if (!body.installationId) throw new Error('Pair response did not include an installation id')

  const userLabel = input.serverLabel?.trim() ?? ''
  const server: SavedServer = {
    id: body.installationId,
    label: userLabel || input.reportedName || urlHost(url),
    hasUserLabel: !!userLabel,
    url,
    sessionToken: body.sessionToken,
    installationId: body.installationId,
    os: body.os,
    lastConnected: Date.now(),
  }

  return { server, sessionToken: body.sessionToken, installationId: body.installationId }
}

export function saveBootstrappedServer(
  urlInput: string,
  credential: SshBootstrapCredential,
  /** What the host advertised when it was discovered. No user names a host on
   *  this path, so the label stays derived and the host can correct it later. */
  reportedName?: string,
  os?: HostOperatingSystem,
): SavedServer {
  const url = normalizeServerUrl(urlInput)
  return {
    id: credential.installationId,
    label: reportedName?.trim() || urlHost(url),
    url,
    sessionToken: credential.sessionToken,
    installationId: credential.installationId,
    os,
    lastConnected: Date.now(),
  }
}
