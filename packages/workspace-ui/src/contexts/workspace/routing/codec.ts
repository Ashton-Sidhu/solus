import { makePane, type Location, type PaneEntry } from './location'
import { CHAT_ROUTE, parseRef, ROUTES, serializeRef, surfaceKey, type RouteRef } from './route-registry'

/**
 * One string form of a location, shared by the web address bar, Electron's
 * in-memory history, the persisted snapshot, agent-emitted links, and
 * notification payloads.
 *
 *   /chat                                          the conversation, no companion
 *   /tasks?p=task/T1&f=1                           one surface beside the board
 *   /tasks?p=task/T1!chat/S2~h1&a=1&f=1            two surfaces, the second active
 *
 * The leading pane's destination is the path. The companion strip is `p`, its
 * surfaces joined by `!`; `a` is the active surface and `f` the focused pane.
 *
 * Parsing is total. A surface whose route no longer exists, or whose params are
 * garbage, is dropped — the rest of the location still opens.
 */

const SURFACE_SEPARATOR = '!'

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

function encodePath(text: string): string {
  return text.split('/').map((segment) => encodeURIComponent(segment).replaceAll('%40', '@')).join('/')
}

export function serializeSurfaces(surfaces: readonly RouteRef[]): string {
  return surfaces.map(serializeRef).join(SURFACE_SEPARATOR)
}

export function parseSurfaces(text: string): RouteRef[] {
  const surfaces: RouteRef[] = []
  for (const part of text.split(SURFACE_SEPARATOR)) {
    const ref = part ? parseRef(part) : null
    // A chat that names no session is the conversation pool's, and only the
    // leading pane renders the pool. As a surface it names nothing.
    if (!ref || (ref.name === 'chat' && !ref.params.sessionId)) continue
    surfaces.push(ref)
  }
  return surfaces
}

export function serializeLocation(location: Location): string {
  const [leading, companion] = location.panes
  const params = new URLSearchParams()
  if (companion) {
    params.set('p', serializeSurfaces(companion.surfaces))
    if (companion.activeSurfaceIndex !== companion.surfaces.length - 1) {
      params.set('a', String(companion.activeSurfaceIndex))
    }
  }
  if (companion && location.focusedPaneId === companion.id) params.set('f', '1')
  const query = params.toString()
  const destination = leading.surfaces[0] ?? CHAT_ROUTE
  return `/${encodePath(serializeRef(destination))}${query ? `?${query}` : ''}`
}

export function parseLocation(text: string): Location {
  const [path, query] = text.replace(/^#/, '').split('?')
  const params = new URLSearchParams(query ?? '')

  const decodedPath = decode(path.replace(/^\//, ''))
  const pathRef = decodedPath === null ? null : parseRef(decodedPath)
  // A link to a surface (`/task/T1`, `/work/w1`) opens it beside the
  // conversation: the leading pane only ever holds a destination.
  const pathIsSurface = !!pathRef && ROUTES[pathRef.name].placement === 'surface'
  const leading = makePane([pathRef && !pathIsSurface ? pathRef : CHAT_ROUTE])
  const panes: PaneEntry[] = [leading]

  // URLSearchParams has already decoded each query value exactly once.
  const surfaces = parseSurfaces(params.get('p') ?? '')
  if (pathRef && pathIsSurface && !surfaces.some((surface) => surfaceKey(surface) === surfaceKey(pathRef))) {
    surfaces.push(pathRef)
  }
  if (surfaces.length > 0) {
    const active = Number(params.get('a') ?? surfaces.length - 1)
    const activeIndex = Number.isInteger(active) && active >= 0 && active < surfaces.length
      ? active
      : surfaces.length - 1
    panes.push(makePane(surfaces, activeIndex))
  }

  const focused = (params.get('f') === '1' || pathIsSurface) && panes[1] ? panes[1] : leading
  return { panes, focusedPaneId: focused.id }
}

/** A single route as a link — what `plan://`, `pr://`, and notifications carry. */
export function serializeRoute(ref: RouteRef): string {
  return `/${encodePath(serializeRef(ref))}`
}

export function parseRoute(text: string): RouteRef | null {
  const decoded = decode(text.replace(/^#/, '').replace(/^\//, '').split('?')[0])
  return decoded === null ? null : parseRef(decoded)
}
