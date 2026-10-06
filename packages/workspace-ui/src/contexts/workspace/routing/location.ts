import { CHAT_ROUTE, ROUTES, sameRoute, surfaceKey, type RouteRef } from './route-registry'

/**
 * The location: the leading pane, which holds one destination, and at most one
 * companion pane, which holds the strip of surfaces opened beside it
 * (docs/plans/companion-surfaces.md).
 *
 * Every function here mutates the location in place. That is deliberate: a new
 * `Location` object on each navigate would invalidate every `$derived` reading
 * any pane, so entries are mutated field by field and arrays are only ever
 * spliced. Callers rely on an untouched pane keeping its object identity.
 */

export type PaneId = string

export interface PaneEntry {
  /** Stable identity — geometry, DOM keying, and focus all attach to it. */
  id: PaneId
  /** Left to right. The leading pane holds exactly one: its destination. */
  surfaces: RouteRef[]
  activeSurfaceIndex: number
  /** The share of the split this pane asks for when it opens, as a percentage.
   *  The first surface states its own measure here — a diff wants more room
   *  than a plan — and PaneForge owns every width after that. */
  defaultSize?: number
}

export interface Location {
  /** The leading pane, then the companion pane when one is open. */
  panes: PaneEntry[]
  focusedPaneId: PaneId
}

/** Which pane a route that may sit in either one asks for. */
export type OpenTarget = 'leading' | 'companion'

export interface SurfaceOpenOptions {
  /** Add the surface without making it the active one. */
  background?: boolean
  /** Replace the active surface rather than add one — a draft becoming the
   *  conversation it started. */
  inPlace?: boolean
}

let paneSequence = 0

export function newPaneId(): PaneId {
  paneSequence += 1
  return `pane_${paneSequence}`
}

export function makePane(surfaces: RouteRef[], activeSurfaceIndex = surfaces.length - 1): PaneEntry {
  return { id: newPaneId(), surfaces, activeSurfaceIndex: Math.max(0, activeSurfaceIndex) }
}

export function initialLocation(): Location {
  const leading = makePane([CHAT_ROUTE])
  return { panes: [leading], focusedPaneId: leading.id }
}

/** What a pane shows: its active surface. */
export function activeSurface(pane: PaneEntry): RouteRef | null {
  return pane.surfaces[pane.activeSurfaceIndex] ?? null
}

export function destinationOf(location: Location): RouteRef {
  return location.panes[0].surfaces[0] ?? CHAT_ROUTE
}

export function companionOf(location: Location): PaneEntry | null {
  return location.panes[1] ?? null
}

export function paneById(location: Location, paneId: PaneId): PaneEntry | null {
  return location.panes.find((pane) => pane.id === paneId) ?? null
}

export function focusedPane(location: Location): PaneEntry {
  return paneById(location, location.focusedPaneId) ?? location.panes[0]
}

/** Where a route goes. `either` routes go where the caller asks, and lead by default. */
export function targetFor(ref: RouteRef, requested?: OpenTarget): OpenTarget {
  const placement = ROUTES[ref.name].placement
  if (placement === 'destination') return 'leading'
  if (placement === 'surface') return 'companion'
  return requested ?? 'leading'
}

/** Put a destination in the leading pane. */
export function openDestination(location: Location, ref: RouteRef): PaneEntry {
  const leading = location.panes[0]
  if (!sameRoute(leading.surfaces[0] ?? null, ref)) leading.surfaces.splice(0, leading.surfaces.length, ref)
  leading.activeSurfaceIndex = 0
  location.focusedPaneId = leading.id
  return leading
}

/**
 * Put a surface in the companion strip. A surface that names a subject already
 * in the strip becomes active and takes the new detail (line, view, scope); a
 * new subject is added to the right of the active surface.
 */
export function openSurface(location: Location, ref: RouteRef, opts: SurfaceOpenOptions = {}): PaneEntry {
  const key = surfaceKey(ref)
  const leading = location.panes[0]
  const destination = leading.surfaces[0]
  if (destination && surfaceKey(destination) === key) {
    if (!opts.background) location.focusedPaneId = leading.id
    return leading
  }

  let companion = companionOf(location)
  if (!companion) {
    companion = makePane([])
    companion.defaultSize = defaultSizeFor(ref)
    location.panes.push(companion)
  }

  const existing = companion.surfaces.findIndex((surface) => surfaceKey(surface) === key)
  if (opts.inPlace && existing === -1 && companion.surfaces.length > 0) {
    companion.surfaces[companion.activeSurfaceIndex] = ref
  } else if (existing !== -1) {
    if (!sameRoute(companion.surfaces[existing], ref)) companion.surfaces[existing] = ref
    if (!opts.background) companion.activeSurfaceIndex = existing
  } else {
    const isEmpty = companion.surfaces.length === 0
    const index = isEmpty ? 0 : companion.activeSurfaceIndex + 1
    companion.surfaces.splice(index, 0, ref)
    if (isEmpty || !opts.background) companion.activeSurfaceIndex = index
  }
  if (!opts.background) location.focusedPaneId = companion.id
  return companion
}

/** Close one surface. Its right neighbour becomes active, or its left one when
 *  it was last; closing the last surface closes the companion pane. */
export function closeSurface(location: Location, index: number): void {
  const companion = companionOf(location)
  if (!companion || index < 0 || index >= companion.surfaces.length) return
  companion.surfaces.splice(index, 1)
  if (companion.surfaces.length === 0) {
    closeCompanion(location)
    return
  }
  if (index < companion.activeSurfaceIndex || companion.activeSurfaceIndex >= companion.surfaces.length) {
    companion.activeSurfaceIndex -= 1
  }
}

/** Keep only the surfaces `keep` answers true for. */
export function closeSurfacesWhere(location: Location, shouldClose: (ref: RouteRef, index: number) => boolean): void {
  const companion = companionOf(location)
  if (!companion) return
  for (let index = companion.surfaces.length - 1; index >= 0; index -= 1) {
    if (shouldClose(companion.surfaces[index], index)) closeSurface(location, index)
    if (!companionOf(location)) return
  }
}

export function activateSurface(location: Location, index: number): void {
  const companion = companionOf(location)
  if (!companion || index < 0 || index >= companion.surfaces.length) return
  companion.activeSurfaceIndex = index
}

/** Drop the companion pane, whatever it holds. */
export function closeCompanion(location: Location): void {
  if (location.panes.length < 2) return
  location.panes.splice(1, location.panes.length - 1)
  location.focusedPaneId = location.panes[0].id
}

/** Put a strip in the companion pane, replacing whatever is there. */
export function showStrip(location: Location, surfaces: RouteRef[], activeSurfaceIndex: number): PaneEntry | null {
  closeCompanion(location)
  if (surfaces.length === 0) return null
  const companion = makePane(surfaces.slice(), Math.min(activeSurfaceIndex, surfaces.length - 1))
  companion.defaultSize = defaultSizeFor(surfaces[0])
  location.panes.push(companion)
  return companion
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
      location.panes.push(makePane(incoming.surfaces.slice(), incoming.activeSurfaceIndex))
      continue
    }
    const sameSurfaces = current.surfaces.length === incoming.surfaces.length
      && current.surfaces.every((surface, index) => sameRoute(surface, incoming.surfaces[index]))
    if (!sameSurfaces) current.surfaces.splice(0, current.surfaces.length, ...incoming.surfaces)
    if (current.activeSurfaceIndex !== incoming.activeSurfaceIndex) {
      current.activeSurfaceIndex = incoming.activeSurfaceIndex
    }
  }
  if (location.panes.length > next.panes.length) {
    location.panes.splice(next.panes.length, location.panes.length - next.panes.length)
  }
  const focusIndex = next.panes.findIndex((pane) => pane.id === next.focusedPaneId)
  location.focusedPaneId = location.panes[Math.max(focusIndex, 0)]?.id ?? location.panes[0].id
}

function defaultSizeFor(ref: RouteRef): number | undefined {
  const weight = ROUTES[ref.name].defaultWeight
  return weight === undefined ? undefined : Math.round(weight * 100)
}
