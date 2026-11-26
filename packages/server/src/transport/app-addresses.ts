import { z } from 'zod'
import type { AppAddress, AppAddressSource, TailscaleServeStatus } from '@solus/contracts/host-api'
import { namesThisMachine } from './web-page-requests'

/**
 * Where an outside app reaches this host's `/mcp` (plans/035 §0.8). A host needs
 * no Solus account for it: Tailscale, or the person's own ingress, serves it too.
 */
export interface AppAddressFacts {
  /** The Solus tunnel's origin while the host is linked and its connector is online. */
  tunnel: string | null
  serve: Pick<TailscaleServeStatus, 'state' | 'url' | 'funnel'>
  /** The host setting `publicAddress`: an https origin, or empty. */
  publicAddress: string
}

/**
 * Every address, in the order an app should take them: the internet ones first
 * (the Solus tunnel, Tailscale Funnel, the person's ingress), then the tailnet.
 * Funnel and Serve are one mapping: with Funnel on, its address is not also
 * listed as tailnet only.
 */
export function appAddressesOf(facts: AppAddressFacts): AppAddress[] {
  const addresses: AppAddress[] = []
  if (facts.tunnel) addresses.push({ source: 'solus', url: `${facts.tunnel}/mcp`, reach: 'internet' })
  const serveUrl = facts.serve.state === 'active' ? facts.serve.url : null
  if (serveUrl && facts.serve.funnel) addresses.push({ source: 'tailscale-funnel', url: `${serveUrl}/mcp`, reach: 'internet' })
  if (facts.publicAddress) addresses.push({ source: 'custom', url: `${facts.publicAddress}/mcp`, reach: 'internet' })
  if (serveUrl && !facts.serve.funnel) addresses.push({ source: 'tailscale-serve', url: `${serveUrl}/mcp`, reach: 'tailnet' })
  return addresses
}

const PROBE_TIMEOUT_MS = 5_000
const resourceSchema = z.object({ resource: z.string() })
const healthSchema = z.object({ installationId: z.string() })
/** What a failed `fetch` throws: its own name and message, and the socket's error as its cause, on Node and Bun. */
const fetchErrorSchema = z.object({
  name: z.string().catch(''),
  message: z.string().catch(''),
  code: z.string().catch(''),
  cause: z.object({ code: z.string().catch(''), message: z.string().catch('') }).catch({ code: '', message: '' }),
})
type FetchError = z.infer<typeof fetchErrorSchema>

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME'])
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ConnectionRefused', 'ConnectionClosed'])

type ProbeFailure = 'dns' | 'tls' | 'timeout' | 'unreachable' | 'network'

function failureOf(error: FetchError): ProbeFailure {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout'
  const code = error.cause.code || error.code
  const message = `${error.message} ${error.cause.message}`
  if (DNS_CODES.has(code) || /getaddrinfo|ENOTFOUND|DNS/i.test(message)) return 'dns'
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(code) || /certificate|tls|ssl/i.test(message)) return 'tls'
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timed? ?out/i.test(message)) return 'timeout'
  if (UNREACHABLE_CODES.has(code) || /refused|unreachable|reset/i.test(message)) return 'unreachable'
  return 'network'
}

function failureReason(failure: ProbeFailure, origin: string): string {
  const host = new URL(origin).host
  switch (failure) {
    case 'dns': return `${host} does not resolve from this host (DNS).`
    case 'tls': return `The https certificate of ${host} is not valid from this host (TLS).`
    case 'timeout': return `${origin} did not answer in ${PROBE_TIMEOUT_MS / 1000} seconds.`
    case 'unreachable': return `Nothing accepts the connection at ${origin}.`
    case 'network': return `The connection to ${origin} failed.`
  }
}

/**
 * A host that asks its own public address goes out and back in. Tailscale often
 * does not take a device's own Funnel from that device, and many routers do not
 * take a device's own public address from inside: the address can work from
 * outside all the same, so the reason says that and does not call it down.
 */
function hairpinNote(source: AppAddressSource): string {
  if (source === 'tailscale-funnel') return ' This host cannot always reach its own Funnel address, so it can still work from outside. Test it from a device on another network.'
  if (source === 'custom') return ' Some routers do not let a device reach its own public address, so it can still work from outside. Test it from a device on another network.'
  return ''
}

export interface AppAddressProbeOptions {
  installationId: string
  fetchImpl?: typeof fetch
}

/**
 * Asks one listed address from this host, as an app would: the `/mcp` sign-in
 * metadata must name this `/mcp` as its resource, and `/health` must name this
 * host. Only an address from `appAddressesOf` comes here, never one a caller
 * sends, and no redirect is followed: the host asks only its own addresses.
 */
export async function probeAppAddress(address: AppAddress, options: AppAddressProbeOptions): Promise<{ reachable: boolean; reason: string | null }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const origin = new URL(address.url).origin
  const read = async (path: string): Promise<{ response: Response } | { failure: ProbeFailure }> => {
    try {
      return { response: await fetchImpl(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { accept: 'application/json' } }) }
    } catch (error) {
      const parsed = fetchErrorSchema.safeParse(error)
      return { failure: parsed.success ? failureOf(parsed.data) : 'network' }
    }
  }
  const down = (reason: string) => ({ reachable: false, reason })
  const metadata = await read('/.well-known/oauth-protected-resource/mcp')
  if ('failure' in metadata) {
    const note = metadata.failure === 'dns' || metadata.failure === 'tls' ? '' : hairpinNote(address.source)
    return down(`${failureReason(metadata.failure, origin)}${note}`)
  }
  const { response } = metadata
  if (response.status >= 300 && response.status < 400) return down(`${origin} answered with a redirect (HTTP ${response.status}), not with Solus. Point it at this host without a redirect.`)
  if (!response.ok) return down(`${origin} answered with HTTP ${response.status}, not with Solus.${response.status === 502 || response.status === 504 ? ' The proxy there cannot reach this host.' : ''}`)
  const body = resourceSchema.safeParse(await response.json().catch(() => null))
  if (!body.success) return down(`Something that is not Solus answers at ${origin}.`)
  // The proxy sends no Host and no X-Forwarded-*: this host cannot tell its requests from local ones.
  if (body.data.resource !== address.url && URL.canParse(body.data.resource) && namesThisMachine(new URL(body.data.resource).hostname)) {
    return down(`The proxy at ${origin} sends neither the Host nor the X-Forwarded-Host header, so this host reads every request through it as a request from this machine. Fix the proxy before you use this address: keep Host, or set X-Forwarded-Host and X-Forwarded-Proto.`)
  }
  if (body.data.resource !== address.url) return down(`${origin} names ${body.data.resource} as its MCP address, not ${address.url}. Check that the proxy sends the Host or X-Forwarded-Host and X-Forwarded-Proto headers.`)
  const health = await read('/health')
  const installationId = 'response' in health && health.response.ok ? healthSchema.safeParse(await health.response.json().catch(() => null)) : null
  if (installationId?.success && installationId.data.installationId !== options.installationId) return down(`Another Solus host answers at ${origin}.`)
  return { reachable: true, reason: null }
}
