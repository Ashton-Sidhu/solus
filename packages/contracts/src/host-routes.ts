import { z } from 'zod'

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
 * - `tunnel`: an `https:` origin that Solus cloud gives the host.
 */
export const routeKindSchema = z.enum(['forwarded', 'lan', 'tailnet', 'tunnel'])
export type RouteKind = z.infer<typeof routeKindSchema>

/** Where a route came from. A new read from one source replaces only that source's routes. */
export const routeSourceSchema = z.enum(['directory', 'host', 'discovery', 'pairing', 'ssh', 'page'])
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

/** The kind of a route a client found by an address alone: a pairing, a scan, or the page's own origin. */
export function routeKindForUrl(url: string): RouteKind {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return 'lan'
  }
  if (hostname.endsWith('.ts.net') || isTailnetAddress(hostname)) return 'tailnet'
  return 'lan'
}

/** A route to `url` from an address alone. */
export function routeForUrl(url: string): HostRoute {
  return { kind: routeKindForUrl(url), url }
}

/** Tailscale gives each device an address in 100.64.0.0/10. */
function isTailnetAddress(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
}

const KIND_ORDER = { forwarded: 0, lan: 1, tailnet: 2, tunnel: 3 } satisfies Record<RouteKind, number>

/**
 * The routes worth dialing from here, in the order to try them: a forward this
 * machine holds, then the local network, then the tailnet, then the tunnel. The
 * tunnel is the fallback, never the other way round, so a host stays usable when
 * Solus cloud is down.
 *
 * - An `https:` page cannot open an `http:` route (mixed content).
 * - A `forwarded` route is a loopback port on the machine that holds the forward,
 *   so only that machine (`localHostId`) can dial it.
 * - A url named by two sources is dialed once.
 */
export function dialableRoutes(routes: readonly HostRoute[], clientOrigin: string, localHostId: string | null = null): HostRoute[] {
  const seen = new Set<string>()
  return routes
    .filter((route) => !(clientOrigin.startsWith('https:') && route.url.startsWith('http:')))
    .filter((route) => route.kind !== 'forwarded' || (!!localHostId && route.viaHostId === localHostId))
    .filter((route) => {
      if (seen.has(route.url)) return false
      seen.add(route.url)
      return true
    })
    .map((route, index) => ({ route, index }))
    .sort((a, b) => KIND_ORDER[a.route.kind] - KIND_ORDER[b.route.kind] || a.index - b.index)
    .map(({ route }) => route)
}

/** The routes from the host's own network position, not the tunnel. */
export function isDirectRoute(route: HostRoute): boolean {
  return route.kind !== 'tunnel'
}

/** How long one route check waits for `/health`. */
export const ROUTE_CHECK_TIMEOUT_MS = 2_500
/** After the tunnel answers, how long a direct route still has to answer first. */
export const DIRECT_ROUTE_GRACE_MS = 300
/** While a host is reached through its tunnel, how often its direct routes are checked again. */
export const DIRECT_ROUTE_RECHECK_MS = 60_000

/** Whether `url` answers `/health` as the host the client saved. Never rejects. */
export type RouteCheck = (url: string, signal: AbortSignal) => Promise<boolean>

interface RouteChoiceTimers {
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/**
 * Which of a host's routes to dial (T3 Code #15467). Every dialable route is asked
 * `/health` at the same time, with no credential, so a dead local-network address
 * costs one short check run in parallel, not a ticket timeout before the next
 * route is tried, and a stale address is never sent a token. A direct route that
 * answers as this host wins; the tunnel wins only when no direct route answers
 * within a short grace after it.
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
    let pending = routes.length
    let tunnelWinner: HostRoute | null = null
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
    for (const route of routes) {
      void check(route.url, controller.signal).catch(() => false).then((answers) => {
        pending -= 1
        if (answers && isDirectRoute(route)) settle(route)
        else if (answers && !tunnelWinner) {
          tunnelWinner = route
          graceTimer = setTimeoutFn(() => settle(tunnelWinner), DIRECT_ROUTE_GRACE_MS)
        }
        if (pending === 0) settle(tunnelWinner)
      })
    }
  })
}

/** A direct route that answers as this host, for a connection that reached it through `currentUrl`'s tunnel. */
export async function directRouteBack(routes: readonly HostRoute[], currentUrl: string, check: RouteCheck, timers: RouteChoiceTimers = {}): Promise<HostRoute | null> {
  const current = routes.find((route) => route.url === currentUrl)
  if (current?.kind !== 'tunnel') return null
  const direct = routes.filter(isDirectRoute)
  return direct.length ? chooseRoute(direct, check, timers) : null
}
