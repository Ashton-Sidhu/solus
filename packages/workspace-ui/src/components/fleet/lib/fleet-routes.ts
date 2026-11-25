import { routeKindLabel, type RouteState } from '@solus/client-core/host-route-control'
import type { RouteKind } from '@solus/contracts/host-routes'
import type { Point } from './fleet-model'

/**
 * Each route of a host as its own wire on the map: the one in use stands out, the
 * others stay quiet, and each state that is not healthy has its own dash and mark,
 * so the map reads without color, in forced colors, and with reduced motion.
 */

/** One saved route of a host, with what it does now (`hostRoutesStore.statesFor`). */
export interface WireRoute {
  url: string
  kind: RouteKind
  state: RouteState | null
  stateText: string | null
}

export interface RouteWireStyle {
  /** A CSS color from the Solus status tokens. */
  color: string
  /** In px; null for the route in use, which is as wide as its traffic. */
  width: number | null
  /** The SVG dash pattern; none for a route that works. */
  dash: string | null
  /** The dash moves: a route being tried. Still with reduced motion. */
  crawls: boolean
  /** The border of the route's mark at its card, which repeats the dash. */
  markBorder: 'solid' | 'dashed' | 'dotted'
  /** A sign on the mark for a route that is refused or blocked. */
  badge: 'refused' | 'blocked' | null
}

const ERROR = 'var(--solus-status-error)'
const QUIET = 'var(--hairline-strong)'

/** How each route state is drawn. Every state but the two that work has a dash of its own. */
export const ROUTE_WIRE_STYLES = {
  'in-use': { color: 'color-mix(in oklch, var(--success) 80%, transparent)', width: null, dash: null, crawls: false, markBorder: 'solid', badge: null },
  standby: { color: QUIET, width: 1, dash: null, crawls: false, markBorder: 'solid', badge: null },
  connecting: { color: 'var(--warning)', width: 1.25, dash: '1 4', crawls: true, markBorder: 'dotted', badge: null },
  'not-in-use': { color: QUIET, width: 1, dash: '4 4', crawls: false, markBorder: 'dashed', badge: null },
  'not-answering': { color: `color-mix(in oklch, ${ERROR} 70%, transparent)`, width: 1.25, dash: '6 3', crawls: false, markBorder: 'dashed', badge: null },
  refused: { color: ERROR, width: 1.25, dash: '8 3 1 3', crawls: false, markBorder: 'dashed', badge: 'refused' },
  'different-server': { color: ERROR, width: 1.25, dash: '8 3 1 3 1 3', crawls: false, markBorder: 'dashed', badge: 'refused' },
  blocked: { color: QUIET, width: 1, dash: '1 6', crawls: false, markBorder: 'dotted', badge: 'blocked' },
} satisfies Record<RouteState, RouteWireStyle>

/** A host this device holds no route state for (this device's own addresses) is drawn as standby. */
export function routeWireStyle(state: RouteState | null): RouteWireStyle {
  return ROUTE_WIRE_STYLES[state ?? 'standby']
}

/** More wires than this into one card read as a blur: the rest are named on the last mark. */
export const MAX_WIRES = 4

export interface RouteWire {
  route: WireRoute
  from: Point
  to: Point
  /** Where the route's mark sits on its wire, near the card. */
  mark: Point
}

export interface FannedRoutes {
  wires: RouteWire[]
  /** The routes past `MAX_WIRES`, named on the last mark. */
  hidden: WireRoute[]
}

/**
 * The wires of one host, in the order it tries its routes, fanned apart: a little
 * where they leave this device, more where they reach the card. `spread` is the
 * distance between two wires at each end, in the map's percent units. The marks
 * stand at different points along the wires, so two marks never cover each other.
 */
export function fanRoutes(routes: readonly WireRoute[], from: Point, to: Point, spread: { start: number; end: number }): FannedRoutes {
  const shown = routes.slice(0, MAX_WIRES)
  const wires = shown.map((route, index) => {
    const offset = index - (shown.length - 1) / 2
    const start = { x: from.x, y: from.y + offset * spread.start }
    const end = { x: to.x, y: to.y + offset * spread.end }
    return { route, from: start, to: end, mark: curvePoint(start, end, 0.84 - index * 0.08) }
  })
  return { wires, hidden: routes.slice(MAX_WIRES) }
}

/** A point `t` of the way along `linkPath(from, to)`: a cubic whose controls sit halfway across. */
export function curvePoint(from: Point, to: Point, t: number): Point {
  const middle = (from.x + to.x) / 2
  const u = 1 - t
  const x = u * u * u * from.x + 3 * u * u * t * middle + 3 * u * t * t * middle + t * t * t * to.x
  const y = u * u * u * from.y + 3 * u * u * t * from.y + 3 * u * t * t * to.y + t * t * t * to.y
  return { x, y }
}

/** "Tailscale · http://100.64.0.2:3000: Standby": a mark's tooltip and accessible name. */
export function routeWireLabel(route: WireRoute): string {
  return `${routeKindLabel(route.kind)} · ${route.url}${route.stateText ? `: ${route.stateText}` : ''}`
}
