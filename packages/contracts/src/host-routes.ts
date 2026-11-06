import { z } from 'zod'
import type { MachineKind } from './uplink'

/**
 * The ways to reach a host (docs/plans/host-routes.md D1). This file is the one
 * owner of the route rules: the kinds, how a new read merges into the routes a
 * client or host keeps, which routes a page can dial and in which order, and
 * which route a dial goes to. Web, desktop, mobile, and the server import it.
 *
 * - `forwarded`: `http://127.0.0.1:<port>` on one machine, held open by an
 *   `ssh -L` process there. Only that machine (`viaHostId`) can dial it.
 * - `lan`: an address on a local network.
 * - `tailnet`: an address on a Tailscale network.
 * - `vpn`: an address in the range Tailscale shares with other VPNs, which no
 *   source has confirmed as Tailscale.
 * - `public`: an address or name on the internet that Solus cloud does not own.
 * - `tunnel`: an `https:` origin that Solus cloud gives the host.
 */
export const routeKindSchema = z.enum(['forwarded', 'lan', 'tailnet', 'vpn', 'public', 'tunnel'])
export type RouteKind = z.infer<typeof routeKindSchema>

/** Where a route came from. A new read from one source replaces only that source's routes. */
export const routeSourceSchema = z.enum(['directory', 'host', 'discovery', 'pairing', 'ssh', 'page', 'user'])
export type RouteSource = z.infer<typeof routeSourceSchema>

export const hostRouteSchema = z.object({
  kind: routeKindSchema,
  url: z.string().min(1),
  /** Only on a `forwarded` route: the installation that holds the forward. */
  viaHostId: z.string().min(1).optional(),
  /** Set when the route is kept (`mergeRoutes`); absent on the wire. */
  source: routeSourceSchema.optional(),
  /** When the source last named this route. */
  seenAt: z.number().optional(),
})
export type HostRoute = z.infer<typeof hostRouteSchema>

/** Managed machines live in a cloud network. Its addresses are not client LAN routes,
 * even when an older host advertised them and a client saved them. */
export function routesForMachine(routes: readonly HostRoute[], kind?: MachineKind): HostRoute[] {
  return routes.filter((route) => kind !== 'managed' || route.kind === 'tunnel')
}

/** A route the host advertised, or discovery found, is forgotten when no read names it for this long. */
export const LEARNED_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** The sources whose routes expire: a host or a scan names them again while they are true. */
const EXPIRING_SOURCES: ReadonlySet<RouteSource> = new Set(['host', 'discovery'])

/**
 * The routes after one read from `source`: that source's earlier routes are
 * replaced by `incoming`, and a learned route that no read named for
 * `LEARNED_ROUTE_TTL_MS` is dropped. Other sources' routes are kept as they are.
 */
export function mergeRoutes(current: readonly HostRoute[], incoming: readonly HostRoute[], source: RouteSource, now: number): HostRoute[] {
  const kept = current.filter((route) => {
    const routeSource = route.source ?? 'pairing'
    if (routeSource === source) return false
    return !EXPIRING_SOURCES.has(routeSource) || now - (route.seenAt ?? 0) < LEARNED_ROUTE_TTL_MS
  })
  const added = incoming.map((route): HostRoute => ({ ...route, source, seenAt: now }))
  return [...added, ...kept]
}

/** A route read again is stamped again only after this long, so a read does not rewrite saved hosts each time. */
const READ_REFRESH_MS = 24 * 60 * 60 * 1000

/**
 * The routes after one read from `source` named `incoming`; null when nothing
 * changed. A scan of this client's networks (`discovery`) and the host's own
 * advertisement (`host`) use it. A host that a scan did not find is not read, so
 * it keeps its earlier discovery route until the route expires: a laptop that comes
 * back to the network dials the host there again.
 */
export function withReadRoutes(routes: readonly HostRoute[], incoming: readonly HostRoute[], source: RouteSource, now: number): HostRoute[] | null {
  const current = routesFrom(routes, source)
  const isSame = current.length === incoming.length
    && incoming.every((route) => current.some((kept) => kept.url === route.url && kept.kind === route.kind))
    && current.every((kept) => now - (kept.seenAt ?? 0) < READ_REFRESH_MS)
  return isSame ? null : mergeRoutes(routes, incoming, source, now)
}

/** The routes from one source. */
export function routesFrom(routes: readonly HostRoute[], source: RouteSource): HostRoute[] {
  return routes.filter((route) => (route.source ?? 'pairing') === source)
}

/**
 * The kind of a route a client found by an address alone: a pairing, a scan, a
 * typed address, or the page's own origin. It says only what the address shows
 * (docs/plans/host-routes.md §12.2).
 */
export function routeKindForUrl(url: string): RouteKind {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return 'lan'
  }
  if (hostname.endsWith('.ts.net')) return 'tailnet'
  if (isSharedAddress(hostname)) return 'vpn'
  return isLocalNetworkName(hostname) ? 'lan' : 'public'
}

/** A route to `url` from an address alone. `onTailnet`: the source knows it is a Tailscale address. */
export function routeForUrl(url: string, onTailnet = false): HostRoute {
  return { kind: onTailnet ? 'tailnet' : routeKindForUrl(url), url }
}

/**
 * Whether a password can cross a connection to `url`: `https:` has TLS, a tailnet
 * has WireGuard, and a loopback address stays on this machine (a forward's port
 * then goes on over SSH). Plain `http:` on a local network can be read by anyone
 * on it, and the host's proof does not change that (docs/plans/ssh-forward-password.md D5).
 *
 * `kind` is the kind of the saved route at `url`. An address in 100.64.0.0/10 alone
 * proves nothing, because other VPNs and carriers share that range, so only a saved
 * `tailnet` route counts (§12.2).
 */
export function isEncryptedRouteUrl(url: string, kind: RouteKind = routeKindForUrl(url)): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') return true
  return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || kind === 'tailnet'
}

function ipv4Parts(hostname: string): number[] | null {
  const parts = hostname.split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part)) ? parts : null
}

/** Tailscale gives each device an address in 100.64.0.0/10, and other VPNs use that range too. */
function isSharedAddress(hostname: string): boolean {
  const parts = ipv4Parts(hostname)
  return !!parts && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
}

function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || ipv4Parts(hostname)?.[0] === 127
}

const LOCAL_NETWORK_SUFFIX = /\.(local|lan|home|internal|intranet|home\.arpa)$/

function isLocalNetworkName(hostname: string): boolean {
  if (isLoopbackName(hostname) || LOCAL_NETWORK_SUFFIX.test(hostname)) return true
  if (hostname.startsWith('[')) return /^\[(f[cd]|fe[89ab])/.test(hostname)
  const parts = ipv4Parts(hostname)
  if (!parts) return !hostname.includes('.')
  const first = parts[0]!
  const second = parts[1]!
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254)
}

const KIND_ORDER = { forwarded: 0, lan: 1, tailnet: 2, vpn: 2, public: 3, tunnel: 4 } satisfies Record<RouteKind, number>

/**
 * Whether a session token on this route would cross a network in clear. A confirmed
 * tailnet route is inside WireGuard, a forwarded route is inside SSH, and a loopback
 * address never leaves the machine.
 */
export function carriesTokenInClear(route: Pick<HostRoute, 'kind' | 'url'>): boolean {
  if (!route.url.startsWith('http:') || route.kind === 'tailnet' || route.kind === 'forwarded') return false
  try {
    return !isLoopbackName(new URL(route.url).hostname.toLowerCase())
  } catch {
    return true
  }
}

/** Why this client does not dial a route it knows. */
export type RouteBlock = 'mixed-content' | 'other-machine' | 'token-in-clear'

/** What a person chose about one host's routes on this client (docs/plans/host-routes.md §12). */
export interface DialChoices {
  /** Route URLs in the person's order; absent is the default order. */
  order?: readonly string[]
  /** The host's session token was paired over HTTPS: it stays off routes that carry it in clear. */
  tokenPairedOverHttps?: boolean
}

/** What a dial reads from a saved host. */
export function dialChoicesOf(host: { routeOrder?: readonly string[]; tokenPairedOverHttps?: boolean }): DialChoices {
  return { order: host.routeOrder, tokenPairedOverHttps: host.tokenPairedOverHttps }
}

/**
 * - An `https:` page cannot open an `http:` route (mixed content).
 * - A `forwarded` route is a loopback port on the machine that holds the forward,
 *   so only that machine (`localHostId`) can dial it.
 * - A token paired over HTTPS does not start to travel in clear.
 */
export function routeBlock(route: HostRoute, clientOrigin: string, localHostId: string | null = null, choices: DialChoices = {}): RouteBlock | null {
  if (clientOrigin.startsWith('https:') && route.url.startsWith('http:')) return 'mixed-content'
  if (route.kind === 'forwarded' && (!localHostId || route.viaHostId !== localHostId)) return 'other-machine'
  if (choices.tokenPairedOverHttps && carriesTokenInClear(route)) return 'token-in-clear'
  return null
}

/** One route for each URL. The host knows what its own address is, so its kind wins. */
function distinctRoutes(routes: readonly HostRoute[]): HostRoute[] {
  const byUrl = new Map<string, HostRoute>()
  for (const route of routes) {
    const seen = byUrl.get(route.url)
    if (!seen) byUrl.set(route.url, route)
    else if (route.source === 'host') byUrl.set(route.url, { ...seen, kind: route.kind })
  }
  return [...byUrl.values()]
}

/**
 * One route for each URL, in the order to try them. The default is by kind: a
 * forward this machine holds, the local network, the tailnet or a VPN, a public
 * address, then the tunnel. The tunnel is the fallback, never the other way round,
 * so a host stays usable when Solus cloud is down. With the person's `order`, its
 * routes keep that order and any other route takes its default place among them.
 */
export function orderedRoutes(routes: readonly HostRoute[], order: readonly string[] = []): HostRoute[] {
  const distinct = distinctRoutes(routes)
    .map((route, index) => ({ route, index }))
    .sort((a, b) => KIND_ORDER[a.route.kind] - KIND_ORDER[b.route.kind] || a.index - b.index)
    .map(({ route }) => route)
  const byUrl = new Map(distinct.map((route) => [route.url, route]))
  const ordered = order.flatMap((url) => byUrl.get(url) ?? [])
  for (const route of distinct) {
    if (order.includes(route.url)) continue
    const next = ordered.findIndex((other) => KIND_ORDER[other.kind] > KIND_ORDER[route.kind])
    ordered.splice(next === -1 ? ordered.length : next, 0, route)
  }
  return ordered
}

/** The routes worth dialing from here, in the order to try them (`routeBlock`, `orderedRoutes`). */
export function dialableRoutes(routes: readonly HostRoute[], clientOrigin: string, localHostId: string | null = null, choices: DialChoices = {}): HostRoute[] {
  return orderedRoutes(routes, choices.order).filter((route) => !routeBlock(route, clientOrigin, localHostId, choices))
}

/** The routes a listing carries: not the directory's, which the directory names, and not the ones a person added on this client. */
export function listedRoutes(routes: readonly HostRoute[]): HostRoute[] {
  return routes.filter((route) => route.source !== 'directory' && route.source !== 'user')
}

/** How long one route check waits for `/health`. */
export const ROUTE_CHECK_TIMEOUT_MS = 2_500
/** After a later route answers, how long an earlier route still has to answer first. */
export const EARLIER_ROUTE_GRACE_MS = 300
/** While a host is reached on a route that is not its first, how often the earlier routes are checked again. */
export const EARLIER_ROUTE_RECHECK_MS = 60_000
/** How long a route that answered but did not connect is passed over. */
export const ROUTE_HOLD_BACK_MS = 300_000

/** Whether `url` answers `/health` as the host the client saved. Never rejects. */
export type RouteCheck = (url: string, signal: AbortSignal) => Promise<boolean>

interface RouteChoiceTimers {
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/**
 * Which of a host's routes to dial (T3 Code #15467). Every dialable route is asked
 * `/health` at the same time, with no credential, so a dead address costs one short
 * check run in parallel, not a ticket timeout before the next route is tried, and a
 * stale address is never sent a token. The first route in order wins as soon as it
 * answers as this host. A later route that answers waits a short grace for the
 * earlier ones, and then the first that answered wins, so a silent route at the
 * head of the list never blocks one that works.
 *
 * `routes` are already dialable and in order (`dialableRoutes`). Null when none
 * answers as this host.
 */
export function chooseRoute(routes: readonly HostRoute[], check: RouteCheck, timers: RouteChoiceTimers = {}): Promise<HostRoute | null> {
  const setTimeoutFn = timers.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = timers.clearTimeoutFn ?? clearTimeout
  if (routes.length === 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    const controller = new AbortController()
    const answers: (boolean | undefined)[] = routes.map(() => undefined)
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const timeout = setTimeoutFn(() => controller.abort(), ROUTE_CHECK_TIMEOUT_MS)
    const settle = (route: HostRoute | null) => {
      if (settled) return
      settled = true
      clearTimeoutFn(timeout)
      if (graceTimer) clearTimeoutFn(graceTimer)
      controller.abort()
      resolve(route)
    }
    const decide = () => {
      const best = answers.findIndex((answer) => answer !== false)
      if (best === -1) settle(null)
      else if (answers[best]) settle(routes[best]!)
      else if (!graceTimer && answers.includes(true)) {
        graceTimer = setTimeoutFn(() => settle(routes[answers.indexOf(true)] ?? null), EARLIER_ROUTE_GRACE_MS)
      }
    }
    routes.forEach((route, index) => {
      void check(route.url, controller.signal).catch(() => false).then((answer) => {
        answers[index] = answer
        decide()
      })
    })
  })
}

/** A route earlier than `currentUrl` that answers as this host, for a connection on a later route. */
export async function earlierRouteBack(routes: readonly HostRoute[], currentUrl: string, check: RouteCheck, timers: RouteChoiceTimers = {}): Promise<HostRoute | null> {
  const current = routes.findIndex((route) => route.url === currentUrl)
  return current > 0 ? chooseRoute(routes.slice(0, current), check, timers) : null
}
