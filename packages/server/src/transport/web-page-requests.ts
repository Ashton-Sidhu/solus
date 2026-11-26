import { isIP } from 'net'
import { hostname } from 'os'
import { z } from 'zod'
import { getServerSettings } from '../host/settings'

let ownMagicDnsName: string | null = null

export function setOwnMagicDnsName(name: string | null): void {
  ownMagicDnsName = name?.trim().replace(/\.$/, '').toLowerCase() ?? null
}

type ProxyHeaders = {
  host?: string | string[]
  'x-forwarded-proto'?: string | string[]
  'x-forwarded-host'?: string | string[]
  'tailscale-funnel-request'?: string | string[]
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** One `Host` or `X-Forwarded-Host` value; a repeated header is none. */
const hostHeaderSchema = z.string().min(1)

/** The host name of a `Host` or `X-Forwarded-Host` value, lower case, without its port. */
function hostNameOf(value: string | string[] | undefined): string | null {
  const header = hostHeaderSchema.safeParse(value)
  if (!header.success) return null
  try { return new URL(`http://${header.data.split(',')[0].trim()}`).hostname.toLowerCase() } catch { return null }
}

/**
 * The origin of the person's own ingress (host setting `publicAddress`) when a
 * request names its host, by `Host` or `X-Forwarded-Host`; null otherwise.
 */
export function publicAddressNamedBy(headers: Pick<ProxyHeaders, 'host' | 'x-forwarded-host'>): string | null {
  const publicAddress = getServerSettings().hostConfig.publicAddress
  if (!publicAddress) return null
  const publicHost = new URL(publicAddress).hostname.toLowerCase()
  return hostNameOf(headers.host) === publicHost || hostNameOf(headers['x-forwarded-host']) === publicHost ? publicAddress : null
}

/**
 * A request that came through a proxy: Tailscale Serve or Funnel, or the
 * person's own ingress (plans/035 §0.8). It never gets the trust of a request
 * from this machine. Every rule here can only remove trust, so a forged header
 * costs its sender, never the host:
 * - a loopback request with `X-Forwarded-*` (Tailscale Serve and Funnel send them);
 * - a loopback request to this machine's own MagicDNS name;
 * - Tailscale Funnel's `Tailscale-Funnel-Request`, from any address;
 * - a request that names the host of `publicAddress`, from any address: an
 *   ingress that sends no forwarded headers, or one on another machine of the
 *   local network, is still not this machine.
 */
export function isProxiedRequest(address: string | undefined, headers: ProxyHeaders): boolean {
  if (headers['tailscale-funnel-request'] !== undefined) return true
  if (publicAddressNamedBy(headers)) return true
  if (!isLoopbackAddress(address)) return false
  if (headers['x-forwarded-proto'] || headers['x-forwarded-host']) return true
  const host = typeof headers.host === 'string' ? headers.host : ''
  return ownMagicDnsName !== null && host.toLowerCase().split(':')[0] === ownMagicDnsName
}

/** Only a local proxy can supply the public origin of a link built from a request. */
export function requestOrigin(address: string | undefined, headers: ProxyHeaders): string | null {
  const isLocal = isLoopbackAddress(address)
  const rawHost = isLocal && typeof headers['x-forwarded-host'] === 'string' ? headers['x-forwarded-host'] : headers.host
  const host = typeof rawHost === 'string' ? rawHost : ''
  const rawProtocol = isLocal ? headers['x-forwarded-proto'] : undefined
  const protocol = rawProtocol === 'https' ? 'https' : 'http'
  try {
    if (!host || host.includes('/') || host.includes(',') || host.includes('@')) return null
    return new URL(`${protocol}://${host}`).origin
  } catch { return null }
}

/** The two headers that say who made a request: one of each, or the request is refused. */
const requestSourceSchema = z.object({ host: z.string().min(1), origin: z.string().optional() })

/**
 * Whether a web page on another site could have made this request
 * (docs/plans/fast-secure-startup.md decision 4). A page the person visits runs on
 * this machine, so network position proves nothing for it: a request with no
 * credential acts as the owner only when this answers false.
 *
 * - `Host` must name this machine: an IP literal, `localhost`, or this machine's own
 *   name. A DNS-rebound name (an attacker's domain pointed at 127.0.0.1) fails here.
 * - `Origin`, when the browser sends one, must be this same host: the host's own
 *   page. A page on another site fails here. A client that is no web page (the CLI,
 *   an agent tool, a native app) sends no `Origin`.
 */
export function couldBeForgedByWebPage(headers: { host?: string | string[]; origin?: string | string[] }): boolean {
  const source = requestSourceSchema.safeParse({ host: headers.host, origin: headers.origin })
  if (!source.success) return true
  const host = source.data.host.toLowerCase()
  try {
    if (!namesThisMachine(new URL(`http://${host}`).hostname)) return true
    return source.data.origin !== undefined && new URL(source.data.origin).host.toLowerCase() !== host
  } catch {
    return true
  }
}

/** An IP literal, `localhost`, or this machine's own name or MagicDNS name. */
export function namesThisMachine(name: string): boolean {
  if (ownMagicDnsName && name === ownMagicDnsName) return true
  if (name === 'localhost' || isIP(name.replace(/^\[|\]$/g, '')) !== 0) return true
  const machine = hostname().toLowerCase()
  return name === machine || name === `${machine.replace(/\.local$/, '')}.local`
}
