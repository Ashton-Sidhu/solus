import { CHAT_ROUTE, ROUTES, sameRoute, type RouteRef } from './route-registry'

/**
 * The location: an ordered list of panes, each with a long-lived base and an
 * optional overlay covering it, plus which pane owns focus. Everything the old
 * named slots did is an operation on this list, so raising `MAX_PANES` is a
 * constant rather than a rewrite.
 *
 * Every function here mutates the location in place. That is deliberate: a new
 * `Location` object on each navigate would invalidate every `$derived` reading
 * any pane, so entries are mutated field by field and the array is only ever
 * spliced. Callers rely on an untouched pane keeping its object identity.
 */

export type PaneId = string

export interface PaneEntry {
  /** Stable identity — geometry, DOM keying, and focus all attach to it. */
  id: PaneId
  /** The long-lived occupant. `null` while the pane exists only for its
   *  overlay, which is what makes closing that overlay close the pane. */
  base: RouteRef | null
  /** A temporary viewer covering the base without replacing it. */
  overlay: RouteRef | null
  /** The share of the split this pane asks for when it opens, as a percentage.
   *  A surface states its own measure here — a diff wants more room than a plan
   *  — and PaneForge owns every width after that, including the user's drags. */
  defaultSize?: number
}

export interface Location {
  /** Ordered left → right, always at least one. */
  panes: PaneEntry[]
  focusedPaneId: PaneId
}

/**
 * Shipped behaviour is two panes, exactly as before. The list model, the codec,
 * and every rule below are already N-shaped; raising this is a constant plus a
 * UI affordance to drive the third pane.
 */
export const MAX_PANES = 2

/**
 * Where a navigation lands, stated relative to the current location:
 * - `focused` — the pane the user is in.
 * - `aside` — the companion pane next to the focused one, created if absent.
 * - `new` — a fresh trailing pane, or the trailing pane itself once at the cap.
 */
export type NavTarget = 'focused' | 'aside' | 'new' | PaneId

let paneSequence = 0

export function newPaneId(): PaneId {
  paneSequence += 1
  return `pane_${paneSequence}`
}

export function makePane(base: RouteRef | null, overlay: RouteRef | null = null): PaneEntry {
  return { id: newPaneId(), base, overlay }
}

export function initialLocation(): Location {
  const leading = makePane(CHAT_ROUTE)
  return { panes: [leading], focusedPaneId: leading.id }
}

/** What a pane actually shows: its overlay if one is up, else its base. */
export function visibleRef(pane: PaneEntry): RouteRef | null {
  return pane.overlay ?? pane.base
}

export function paneIndexOf(location: Location, paneId: PaneId): number {
  return location.panes.findIndex((pane) => pane.id === paneId)
}

export function paneById(location: Location, paneId: PaneId): PaneEntry | null {
  return location.panes.find((pane) => pane.id === paneId) ?? null
}

export function focusedPane(location: Location): PaneEntry {
  return paneById(location, location.focusedPaneId) ?? location.panes[0]
}

/** The first pane whose base matches — where an exclusive route already lives. */
export function findPane(
  location: Location,
  match: (pane: PaneEntry) => boolean,
): PaneEntry | null {
  // Trailing-first: replace-in-place rules keep a split layout split rather
  // than migrating content back into the leading pane.
  for (let i = location.panes.length - 1; i >= 0; i -= 1) {
    if (match(location.panes[i])) return location.panes[i]
  }
  return null
}

/** Whether this destination is showing anywhere, regardless of params. */
export function isRouteOpen(location: Location, name: RouteRef['name']): boolean {
  return location.panes.some((pane) => pane.base?.name === name || pane.overlay?.name === name)
}

export function refFor(location: Location, name: RouteRef['name']): RouteRef | null {
  for (const pane of location.panes) {
    if (pane.overlay?.name === name) return pane.overlay
    if (pane.base?.name === name) return pane.base
  }
  return null
}

function ensureFocusIsReal(location: Location): void {
  if (!paneById(location, location.focusedPaneId)) {
    location.focusedPaneId = location.panes[0].id
  }
}

/** Append a pane, or return the trailing one when already at the cap. */
function appendOrReuseTrailing(location: Location): PaneEntry {
  if (location.panes.length >= MAX_PANES) return location.panes[location.panes.length - 1]
  const pane = makePane(null)
  location.panes.push(pane)
  return pane
}

/** The companion beside the focused pane — the one `aside` means. */
function asidePane(location: Location): PaneEntry {
  const index = paneIndexOf(location, location.focusedPaneId)
  const next = location.panes[Math.max(index, 0) + 1]
  if (next) return next
  const pane = appendOrReuseTrailing(location)
  // At the cap with focus already on the trailing pane there is no companion to
  // the right; the leading pane is the only other one.
  return pane === focusedPane(location) && location.panes.length > 1
    ? location.panes[location.panes.length - 2]
    : pane
}

function resolveTargetPane(location: Location, target: NavTarget, ref: RouteRef): PaneEntry {
  const placement = ROUTES[ref.name].placement
  let pane: PaneEntry
  if (target === 'aside') pane = asidePane(location)
  else if (target === 'new') pane = appendOrReuseTrailing(location)
  else if (target === 'focused') pane = focusedPane(location)
  else pane = paneById(location, target) ?? focusedPane(location)

  // `aside` placement is relative, not a slot name: it means "not the leading
  // pane", which still says something useful once there are five of them.
  if (placement === 'aside' && pane === location.panes[0]) return asidePane(location)
  return pane
}

/**
 * Put a route into the location. The one placement rule in the app: exclusivity
 * first (replace where the group already lives), then the requested target,
 * bounded by the route's own placement and `MAX_PANES`.
 */
export function place(location: Location, ref: RouteRef, target: NavTarget = 'focused'): PaneEntry {
  const descriptor = ROUTES[ref.name]

  if (descriptor.placement === 'overlay') {
    const pane = resolveTargetPane(location, target === 'focused' ? 'aside' : target, ref)
    pane.overlay = ref
    return pane
  }

  const group = descriptor.exclusiveGroup
  if (group) {
    const existing = findPane(location, (pane) => !!pane.base && ROUTES[pane.base.name].exclusiveGroup === group)
    if (existing) {
      if (!sameRoute(existing.base, ref)) existing.base = ref
      location.focusedPaneId = existing.id
      return existing
    }
  }

  const pane = resolveTargetPane(location, target, ref)
  if (!sameRoute(pane.base, ref)) pane.base = ref
  pane.overlay = null
  location.focusedPaneId = pane.id
  return pane
}

/**
 * Close a pane. The leading pane is the workspace's home, so it falls back to
 * `home` rather than disappearing — which is also what keeps the location from
 * ever reaching zero panes. `home` is the conversation unless the caller knows
 * better: with no tab open the pool has nothing to show, and the workspace
 * names the composer instead.
 */
export function closePane(location: Location, paneId: PaneId, home: RouteRef = CHAT_ROUTE): void {
  const index = paneIndexOf(location, paneId)
  if (index === -1) return
  if (index === 0) {
    const pane = location.panes[0]
    pane.overlay = null
    if (!sameRoute(pane.base, home)) pane.base = home
    location.focusedPaneId = pane.id
    return
  }
  location.panes.splice(index, 1)
  ensureFocusIsReal(location)
}

/** Drop a pane's overlay, and the pane itself when it only existed to host it. */
export function closeOverlay(location: Location, paneId: PaneId): void {
  const pane = paneById(location, paneId)
  if (!pane?.overlay) return
  pane.overlay = null
  if (!pane.base) closePane(location, paneId)
}

/**
 * Send a pane's route one position over — the generic form of "open in split"
 * and "move back to the main pane". The source pane is dropped afterwards, so
 * this moves content rather than swapping two surfaces.
 */
export function movePane(
  location: Location,
  paneId: PaneId,
  delta: number,
  home: RouteRef = CHAT_ROUTE,
): void {
  const index = paneIndexOf(location, paneId)
  if (index === -1) return
  const source = location.panes[index]
  const targetIndex = index + delta
  if (targetIndex < 0) return

  const { base, overlay } = source
  if (targetIndex >= location.panes.length) {
    if (location.panes.length >= MAX_PANES) return
    const pane = makePane(base, overlay)
    location.panes.push(pane)
    dropPane(location, source.id, home)
    location.focusedPaneId = pane.id
    return
  }

  const target = location.panes[targetIndex]
  target.base = base
  target.overlay = overlay
  dropPane(location, source.id, home)
  location.focusedPaneId = target.id
}

/** Remove a pane outright during a move — no conversation fallback, because the
 *  route it held is being placed elsewhere in the same operation. The leading
 *  pane still cannot vanish, so it rests on `home` like a closed one does. */
function dropPane(location: Location, paneId: PaneId, home: RouteRef): void {
  const index = paneIndexOf(location, paneId)
  if (index === -1) return
  if (index === 0) {
    location.panes[0].base = home
    location.panes[0].overlay = null
    return
  }
  location.panes.splice(index, 1)
  ensureFocusIsReal(location)
}

/**
 * Reconcile `location` onto `next` without rebuilding it: panes are matched by
 * position so an untouched pane keeps its id — and therefore its geometry, its
 * DOM, and any keep-alive surface hanging off it — across back/forward.
 */
export function applyLocation(location: Location, next: Location): void {
  for (let i = 0; i < next.panes.length; i += 1) {
    const incoming = next.panes[i]
    const current = location.panes[i]
    if (!current) {
      location.panes.push(makePane(incoming.base, incoming.overlay))
      continue
    }
    if (!sameRoute(current.base, incoming.base)) current.base = incoming.base
    if (!sameRoute(current.overlay, incoming.overlay)) current.overlay = incoming.overlay
  }
  if (location.panes.length > next.panes.length) {
    location.panes.splice(next.panes.length, location.panes.length - next.panes.length)
  }
  const focusIndex = next.panes.findIndex((pane) => pane.id === next.focusedPaneId)
  location.focusedPaneId = location.panes[Math.max(focusIndex, 0)]?.id ?? location.panes[0].id
}
