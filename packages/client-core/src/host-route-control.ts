import { carriesTokenInClear, dialChoicesOf, orderedRoutes, routeBlock, routeForUrl, routesForMachine, type HostRoute, type RouteBlock, type RouteKind } from '@solus/contracts/host-routes'
import type { MachineKind } from '@solus/contracts/uplink'
import { newHealthNonce } from '@solus/contracts/host-identity'
import { answersAsSavedHost, type SavedHostIdentity } from './host-link'
import { readHostHealth } from './host-http'
import { normalizeServerUrl } from './pairing'

/**
 * What a person controls about a host's routes (docs/plans/host-routes.md §12): the
 * list they see, the check before an address is added, and each change to a saved
 * host. Desktop and web (`server-registry.ts`) and mobile (`host-registry.ts`) call
 * these, so every client has one set of rules and one set of words.
 */

/** The part of a saved host that route control reads and writes, on every client. */
export interface RouteHolder {
  routes: HostRoute[]
  /** Route URLs in the person's order; absent is the default order. */
  routeOrder?: string[]
  /** The session token was paired over HTTPS (`routeBlock`). */
  tokenPairedOverHttps?: boolean
  uplink?: { kind?: MachineKind }
}

export interface RouteRow {
  url: string
  kind: RouteKind
  /** Read from the host or a scan, or owned by the directory or a forward: it can move, but it cannot be removed. */
  isLearned: boolean
  canRemove: boolean
  /** Why this client does not dial it; null when it can. */
  block: RouteBlock | null
}

/** Where the list is read from. */
export interface RouteViewer {
  clientOrigin: string
  localHostId?: string | null
}

const REMOVABLE_SOURCES: ReadonlySet<string> = new Set(['user', 'pairing'])

/** Every route of a host, in the order this client tries them. */
export function routeRows(holder: RouteHolder, viewer: RouteViewer): RouteRow[] {
  const routes = routesForMachine(holder.routes, holder.uplink?.kind)
  const rows = orderedRoutes(routes, holder.routeOrder).map((route): RouteRow => ({
    url: route.url,
    kind: route.kind,
    isLearned: routes.some((other) => other.url === route.url && !REMOVABLE_SOURCES.has(other.source ?? 'pairing')),
    canRemove: false,
    block: routeBlock(route, viewer.clientOrigin, viewer.localHostId ?? null, dialChoicesOf(holder)),
  }))
  if (holder.uplink?.kind === 'managed') return rows
  // The last route that this client can dial stays: without it the host cannot be reached from here.
  return rows.map((row) => ({ ...row, canRemove: !row.isLearned && rows.some((other) => other.url !== row.url && !other.block) }))
}

/** The route the link is on, for a host that is connected now. */
export function routeInUse(rows: readonly RouteRow[], dialedUrl: string | null, isReady: boolean): string | null {
  return isReady && rows.some((row) => row.url === dialedUrl) ? dialedUrl : null
}

export function withUserRoute<Holder extends RouteHolder>(holder: Holder, url: string, now: number): Holder {
  return { ...holder, routes: [...holder.routes, { ...routeForUrl(url), source: 'user', seenAt: now }] }
}

export function withoutRoute<Holder extends RouteHolder>(holder: Holder, url: string): Holder {
  const next: Holder = { ...holder, routes: holder.routes.filter((route) => route.url !== url) }
  if (holder.routeOrder) next.routeOrder = holder.routeOrder.filter((ordered) => ordered !== url)
  return next
}

/** The host with `url` one place earlier (-1) or later (1) in the list; the same host at either end. */
export function withRouteMoved<Holder extends RouteHolder>(holder: Holder, url: string, step: -1 | 1): Holder {
  const urls = orderedRoutes(routesForMachine(holder.routes, holder.uplink?.kind), holder.routeOrder).map((route) => route.url)
  const from = urls.indexOf(url)
  const to = from + step
  if (from === -1 || to < 0 || to >= urls.length) return holder
  urls[from] = urls[to]!
  urls[to] = url
  return { ...holder, routeOrder: urls }
}

export type NewRouteRefusal =
  | 'invalid-address'
  | 'managed-host'
  | 'already-saved'
  | 'mixed-content'
  | 'token-in-clear'
  | 'no-identity-key'
  | 'no-answer'
  | 'another-host'

export type NewRouteCheck = { ok: true; url: string } | { ok: false; refusal: NewRouteRefusal }

/** A typed address as a route URL; null when it is not one: no other scheme, and no credential in the URL. */
export function routeUrlFromInput(input: string): string | null {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null
  try {
    const url = new URL(normalizeServerUrl(trimmed))
    if (url.username || url.password || !url.hostname) return null
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export interface NewRouteInput {
  address: string
  holder: RouteHolder
  identity: SavedHostIdentity
  viewer: RouteViewer
  signal: AbortSignal
  nonce?: () => string
}

/**
 * Whether an address can become a route. It must answer as this host, with a fresh
 * proof, before it is saved; no credential goes to it here. A later dial proves
 * it again (`routeNeedsProof`), so an address that goes stale gets nothing either.
 */
export async function checkRouteToAdd(fetchImpl: typeof fetch, input: NewRouteInput): Promise<NewRouteCheck> {
  const { holder, identity, viewer, signal } = input
  const url = routeUrlFromInput(input.address)
  if (!url) return { ok: false, refusal: 'invalid-address' }
  if (holder.uplink?.kind === 'managed') return { ok: false, refusal: 'managed-host' }
  if (holder.routes.some((route) => route.url === url)) return { ok: false, refusal: 'already-saved' }
  if (viewer.clientOrigin.startsWith('https:') && url.startsWith('http:')) return { ok: false, refusal: 'mixed-content' }
  if (holder.tokenPairedOverHttps && carriesTokenInClear(routeForUrl(url))) return { ok: false, refusal: 'token-in-clear' }
  if (!identity.identityKey) return { ok: false, refusal: 'no-identity-key' }
  const route = { url, source: 'user' as const }
  if (await answersAsSavedHost(fetchImpl, route, identity, signal, input.nonce ?? newHealthNonce)) return { ok: true, url }
  const health = await readHostHealth(fetchImpl, url, signal)
  return { ok: false, refusal: health ? 'another-host' : 'no-answer' }
}

export function newRouteRefusalText(refusal: NewRouteRefusal): string {
  switch (refusal) {
    case 'invalid-address': return 'Enter an address that starts with http:// or https://, or a host and port.'
    case 'managed-host': return 'Solus Cloud sets how this host is reached.'
    case 'already-saved': return 'This host already has that address.'
    case 'mixed-content': return 'This page uses HTTPS, so the browser blocks an http:// address.'
    case 'token-in-clear': return 'This device paired over HTTPS, so its token does not travel over plain HTTP. Use an https:// address.'
    case 'no-identity-key': return 'Connect to this host once first, so Solus can check that the address is the same host.'
    case 'no-answer': return 'Nothing answered at that address.'
    case 'another-host': return 'That address answered, but not as this host.'
  }
}

export function routeKindLabel(kind: RouteKind): string {
  switch (kind) {
    case 'forwarded': return 'SSH forward'
    case 'lan': return 'Local network'
    case 'tailnet': return 'Tailscale'
    case 'vpn': return 'VPN'
    case 'public': return 'Public address'
    case 'tunnel': return 'Solus Cloud'
  }
}

export function routeBlockText(block: RouteBlock): string {
  switch (block) {
    case 'mixed-content': return 'Blocked: this page uses HTTPS.'
    case 'other-machine': return 'Works only from the machine that holds the forward.'
    case 'token-in-clear': return 'Not used: this device paired over HTTPS.'
  }
}
