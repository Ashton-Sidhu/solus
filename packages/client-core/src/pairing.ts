import { z } from 'zod'
import type { KnownHost } from './known-host'
import { mergeRoutes, routeForUrl } from '@solus/contracts/host-routes'
import { hostIdentityKeySchema } from '@solus/contracts/host-identity'
import { DEFAULT_SERVER_PORT } from '@solus/contracts/types'
import { PAIR_APPROVAL_WAIT_MS, type PairApprovalStartRequest, type PairApprovalWaitRequest } from '@solus/contracts/add-machine'

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
  identityKey: hostIdentityKeySchema.optional().catch(undefined),
}).catch({})

export interface ParsedPairLink {
  url: string
  pairToken: string
}

export interface PairServerInput {
  url: string
  /** The host's pairing code or link token. Absent when the host trusts this
   *  device by network position (its `/health` answers `requireAuth: false`). */
  pairToken?: string
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
  /** The session token this pairing replaces. The host revokes it once the new one is issued, so a device paired again leaves one device row. */
  replacesSessionToken?: string
  /** The client's own fetch; the global one when absent. */
  fetchImpl?: typeof fetch
  /** Discovery found the host on the tailnet, so its address is saved as a `tailnet`
   *  route, not `vpn` (docs/plans/tailscale-support.md D8). */
  onTailnet?: boolean
}

export interface PairServerResult {
  /** The host as this device paired it; `hostCatalog.pair` keeps it. */
  server: KnownHost
  sessionToken: string
  installationId: string
}

/** A bounded pairing request on browser, Node, and React Native. */
export async function withPairingTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try { return await run(controller.signal) } finally { clearTimeout(timer) }
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

/** The same pairing link handed to the Solus mobile app, which checks the host before it pairs. */
export function appPairLink(pairingLink: string): string {
  return `solus://pair?link=${encodeURIComponent(pairingLink)}`
}

/** The link another device opens or scans to pair; `parsePairLink` reads it back. */
export function pairLink(endpoint: PairEndpoint, pairToken: string): string {
  return `http://${endpoint.host}:${endpoint.port}/pair#token=${pairToken}`
}

export function hostedPairLink(serveUrl: string, pairToken: string): string {
  const host = new URL(serveUrl).host
  return `https://app.solus.sh/pair?host=${encodeURIComponent(host)}#token=${encodeURIComponent(pairToken)}`
}

export function parsePairLink(link: string): ParsedPairLink | null {
  try {
    const u = new URL(link.trim())
    const fragment = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash
    const params = new URLSearchParams(fragment)
    const pairToken = params.get('token')
    if (!pairToken) return null
    if (u.origin === 'https://app.solus.sh' && u.pathname === '/pair') {
      const host = u.searchParams.get('host')
      if (!host || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?::\d{1,5})?$/i.test(host)) return null
      const target = new URL(`https://${host}`)
      if (target.port && (Number(target.port) < 1 || Number(target.port) > 65535)) return null
      return { url: target.origin, pairToken }
    }
    return { url: `${u.protocol}//${u.host}`, pairToken }
  } catch {
    return null
  }
}

/** What a person entered where a pairing code goes: a pair link, a 6-digit code, or neither. */
export type PairSecret = { kind: 'link'; url: string; pairToken: string } | { kind: 'code'; code: string }

/**
 * Checks the shape of a pairing secret before it goes anywhere
 * (docs/plans/add-machine-card.md rule 1). A code is 6 digits; spaces and a dash
 * between them are allowed. Null for anything else, such as a password: the
 * caller must then send nothing.
 */
export function classifyPairSecret(value: string): PairSecret | null {
  const link = parsePairLink(value)
  if (link) return { kind: 'link', ...link }
  const compact = value.trim().replace(/[\s-]/g, '')
  return /^\d{6}$/.test(compact) ? { kind: 'code', code: compact } : null
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

/**
 * Where a person gets a pairing code on a machine, for every surface that asks
 * for one: from its shell, which a machine with no screen has, or from Solus
 * there. A command is in backticks.
 */
export function pairCodeSteps(machineName: string): string {
  return `On ${machineName}, run \`solus pair\`, or choose Show pairing code in the command palette of Solus there.`
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
      replacesSessionToken: input.replacesSessionToken,
    }),
  })
  if (!res.ok) {
    const body = serverErrorSchema.parse(await res.json().catch(() => ({})))
    throw new Error(body.error ?? `Pair failed (${res.status})`)
  }
  return pairedServer(url, pairResponseSchema.parse(await res.json().catch(() => ({}))), input)
}

/** The host a pairing reply names, as this device keeps it. `/pair` and an approved request reply alike. */
function pairedServer(url: string, body: z.infer<typeof pairResponseSchema>, input: Pick<PairServerInput, 'serverLabel' | 'reportedName' | 'onTailnet'>): PairServerResult {
  if (!body.sessionToken) throw new Error('Pair response did not include a session token')
  if (!body.installationId) throw new Error('Pair response did not include an installation id')

  const userLabel = input.serverLabel?.trim() ?? ''
  const server: KnownHost = {
    id: body.installationId,
    label: userLabel || input.reportedName || urlHost(url),
    hasUserLabel: !!userLabel,
    routes: mergeRoutes([], [routeForUrl(url, input.onTailnet)], 'pairing', Date.now()),
    sessionToken: body.sessionToken,
    installationId: body.installationId,
    os: body.os,
    identityKey: body.identityKey,
    lastConnected: Date.now(),
  }
  if (url.startsWith('https:')) server.tokenPairedOverHttps = true

  return { server, sessionToken: body.sessionToken, installationId: body.installationId }
}

export type RequestPairApprovalResult =
  | { status: 'approved'; result: PairServerResult }
  | { status: 'denied' } | { status: 'expired' } | { status: 'unavailable' }

const approvalStartSchema = z.object({ requestId: z.string().min(1), expiresAt: z.number(), waitToken: z.string().min(1) })
const approvalStatusSchema = z.object({ status: tolerantString }).catch({})
/** One wait may take `PAIR_APPROVAL_WAIT_MS` on the host; past this the host is not answering. */
const APPROVAL_CALL_TIMEOUT_MS = PAIR_APPROVAL_WAIT_MS + 15_000

/**
 * Asks a host to pair this device without a code (docs/plans/add-machine-card.md,
 * "The approval request"). The caller makes `checkCode` with `formatCheckCode` and
 * shows it; the host's owner sees the same code with the request and approves or
 * denies it. `onWaiting` runs once the host holds the request. It waits until a
 * result or until `signal` aborts, which throws.
 */
export async function requestPairApproval(input: Omit<PairServerInput, 'pairToken'> & { checkCode: string; signal?: AbortSignal; onWaiting?: (start: { expiresAt: number }) => void }): Promise<RequestPairApprovalResult> {
  const url = normalizeServerUrl(input.url)
  const host = urlHost(url)
  const post = async (path: '/pair/request' | '/pair/request/wait', body: PairApprovalStartRequest | PairApprovalWaitRequest): Promise<Response> => {
    // A manual time limit: React Native has no `AbortSignal.any` or `AbortSignal.timeout`.
    const call = new AbortController()
    const stop = () => call.abort()
    const timer = setTimeout(stop, APPROVAL_CALL_TIMEOUT_MS)
    input.signal?.addEventListener('abort', stop, { once: true })
    let res: Response
    try {
      if (input.signal?.aborted) throw stoppedError()
      res = await (input.fetchImpl ?? fetch)(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: call.signal,
      })
    } catch (error) {
      if (input.signal?.aborted) throw stoppedError()
      if (call.signal.aborted) throw new Error(`${host} did not answer the approval request in time.`)
      throw new Error(`Could not reach ${host}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', stop)
    }
    if (res.status === 429) throw new Error(`${host} refused the approval request: too many requests. Try again in a few minutes.`)
    return res
  }
  const failure = async (res: Response): Promise<Error> => {
    const body = serverErrorSchema.parse(await res.json().catch(() => ({})))
    return new Error(body.error ?? `Approval request failed (${res.status})`)
  }

  const startRes = await post('/pair/request', { deviceLabel: input.deviceLabel.trim().slice(0, 64) || 'Unknown device', checkCode: input.checkCode, replacesSessionToken: input.replacesSessionToken })
  // An older host, or one with pairing off, has no such route.
  if (startRes.status === 404) return { status: 'unavailable' }
  if (!startRes.ok) throw await failure(startRes)
  const started = approvalStartSchema.safeParse(await startRes.json().catch(() => null))
  if (!started.success) throw new Error(`${host} sent an approval request reply that Solus cannot read.`)
  const { requestId, waitToken, expiresAt } = started.data
  input.onWaiting?.({ expiresAt })

  for (;;) {
    const res = await post('/pair/request/wait', { requestId, waitToken })
    if (res.status === 404) return { status: 'unavailable' }
    if (!res.ok) throw await failure(res)
    const body: unknown = await res.json().catch(() => null)
    const { status } = approvalStatusSchema.parse(body)
    if (status === 'pending') continue
    if (status === 'denied' || status === 'expired') return { status }
    if (status === 'approved') return { status: 'approved', result: pairedServer(url, pairResponseSchema.parse(body), input) }
    throw new Error(`${host} sent an approval status that Solus cannot read.`)
  }
}

function stoppedError(): Error {
  const error = new Error('The approval request was stopped.')
  error.name = 'AbortError'
  return error
}
