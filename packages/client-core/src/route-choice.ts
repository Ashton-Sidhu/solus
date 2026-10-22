import type { HostRoute } from '@solus/contracts/uplink'

/**
 * Which of a host's routes to dial (T3 Code #15467). Every dialable route is asked
 * `/health` at the same time, with no credential, so a dead local-network address
 * costs one short check run in parallel, not a ticket timeout before the next
 * route is tried, and a stale address is never sent a token. A direct route that
 * answers as this host wins; the tunnel wins only when no direct route answers
 * within a short grace after it.
 */

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

/** The route to dial among `routes` (already dialable, direct first), or null when none answers as this host. */
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
        if (answers && route.kind === 'direct') settle(route)
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
  const direct = routes.filter((route) => route.kind === 'direct')
  return direct.length ? chooseRoute(direct, check, timers) : null
}
