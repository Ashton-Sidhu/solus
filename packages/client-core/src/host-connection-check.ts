import type { HostRoute, RouteKind } from '@solus/contracts/host-routes'

/**
 * A short, active read of the way to a host (docs/plans/host-readiness.md). A failed
 * dial cannot name a stage: a WebSocket error has no HTTP status. It runs when a
 * person asks, never in the background.
 */

/** How long one address has to answer. A tunnel can be slower than a route check allows. */
const CHECK_TIMEOUT_MS = 5_000

/** What one address did. */
export type AddressAnswer =
  /** An HTTP answer that this client can read. */
  | { kind: 'status'; status: number }
  /** Something answered, but this client cannot read it: a browser hides an answer without CORS headers. */
  | { kind: 'opaque' }
  | { kind: 'no-answer' }
  | { kind: 'timeout' }

export type RouteAnswer =
  /** It proved that it is the saved host. */
  | { kind: 'host' }
  /** It answered `/health`, but it did not prove that it is the saved host. */
  | { kind: 'unproven' }
  | AddressAnswer

export interface HostConnectionCheck {
  at: number
  /** The device says that it has no network. A device that says it has one proves nothing. */
  isDeviceOffline: boolean
  /** Null when this client knows no Solus Cloud for the host. */
  cloud: AddressAnswer | null
  routes: readonly { kind: RouteKind; url: string; answer: RouteAnswer }[]
}

/** One read of an address. Never rejects. */
export async function readAddress(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<AddressAnswer> {
  try {
    return { kind: 'status', status: (await fetchImpl(url, { signal })).status }
  } catch {
    if (signal.aborted) return { kind: 'timeout' }
  }
  // A browser rejects an answer that has no CORS headers, and a Cloudflare error page
  // has none. In `no-cors` mode the same answer resolves, with nothing to read.
  try {
    await fetchImpl(url, { signal, mode: 'no-cors' })
    return { kind: 'opaque' }
  } catch {
    return signal.aborted ? { kind: 'timeout' } : { kind: 'no-answer' }
  }
}

async function readRoute(
  fetchImpl: typeof fetch,
  url: string,
  answersAsHost: (url: string, signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
): Promise<RouteAnswer> {
  const answer = await readAddress(fetchImpl, `${url}/health`, signal)
  if (answer.kind !== 'status' || answer.status !== 200) return answer
  return (await answersAsHost(url, signal).catch(() => false)) ? { kind: 'host' } : { kind: 'unproven' }
}

export interface ConnectionCheckInput {
  routes: readonly HostRoute[]
  /** The account origin of the host, when this client has one. */
  cloudUrl: string | null
  answersAsHost: (url: string, signal: AbortSignal) => Promise<boolean>
  fetchImpl: typeof fetch
  now?: () => number
}

export async function runConnectionCheck(input: ConnectionCheckInput): Promise<HostConnectionCheck> {
  const { routes, cloudUrl, answersAsHost, fetchImpl } = input
  // A timeout for each address: a slow one must not end the read of another.
  const signal = () => AbortSignal.timeout(CHECK_TIMEOUT_MS)
  const [cloud, answers] = await Promise.all([
    cloudUrl ? readAddress(fetchImpl, `${cloudUrl}/.well-known/openid-configuration`, signal()) : null,
    Promise.all(routes.map((route) => readRoute(fetchImpl, route.url, answersAsHost, signal()))),
  ])
  return {
    at: (input.now ?? Date.now)(),
    isDeviceOffline: globalThis.navigator?.onLine === false,
    cloud,
    routes: routes.map((route, index) => ({ kind: route.kind, url: route.url, answer: answers[index]! })),
  }
}
