import { makePane, type Location, type PaneEntry } from './location'
import { CHAT_ROUTE, parseRef, serializeRef, type RouteRef } from './route-registry'

/**
 * One string form of a location, shared by the web address bar, Electron's
 * in-memory history, the persisted snapshot, agent-emitted links, and
 * notification payloads.
 *
 *   /chat/tab_abc                                    one pane
 *   /chat/tab_abc?p=prReview/4821&f=1                two panes, focus right
 *   /chat/tab_abc?p=prReview/4821!diff/tab_abc/session&f=1
 *   /chat/tab_abc?p=plan/p_88&p=work/w_12&f=2        three panes — same grammar
 *
 * The leading pane is the path; every other pane is an ordered `p`; `!`
 * attaches an overlay; `f` is the focused pane's index. Adding a pane adds a
 * `p`, which is the whole point.
 *
 * Parsing is total. A pane whose route no longer exists, or whose params are
 * garbage, is dropped — the rest of the location still opens.
 */

const OVERLAY_SEPARATOR = '!'

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

function serializePane(pane: PaneEntry): string {
  const base = pane.base ? serializeRef(pane.base) : ''
  const overlay = pane.overlay ? `${OVERLAY_SEPARATOR}${serializeRef(pane.overlay)}` : ''
  return `${base}${overlay}`
}

function parsePane(text: string): PaneEntry | null {
  const cut = text.indexOf(OVERLAY_SEPARATOR)
  const baseText = cut === -1 ? text : text.slice(0, cut)
  const overlayText = cut === -1 ? '' : text.slice(cut + 1)
  const base = baseText ? parseRef(baseText) : null
  const overlay = overlayText ? parseRef(overlayText) : null
  if (!base && !overlay) return null
  return makePane(base, overlay)
}

export function serializeLocation(location: Location): string {
  const [leading, ...rest] = location.panes
  const params = new URLSearchParams()
  for (const pane of rest) params.append('p', serializePane(pane))
  const focusIndex = location.panes.findIndex((pane) => pane.id === location.focusedPaneId)
  if (focusIndex > 0) params.set('f', String(focusIndex))
  const query = params.toString()
  return `/${encodePath(serializePane(leading))}${query ? `?${query}` : ''}`
}

export function parseLocation(text: string): Location {
  const [path, query] = text.replace(/^#/, '').split('?')
  const params = new URLSearchParams(query ?? '')

  const decodedPath = decode(path.replace(/^\//, ''))
  const leading = (decodedPath === null ? null : parsePane(decodedPath)) ?? makePane(CHAT_ROUTE)
  // The leading pane always holds a base: it is the pane the conversation
  // chrome belongs to, so it cannot be overlay-only.
  if (!leading.base) leading.base = CHAT_ROUTE

  const panes: PaneEntry[] = [leading]
  for (const raw of params.getAll('p')) {
    // URLSearchParams has already decoded each query value exactly once.
    const pane = parsePane(raw)
    if (!pane) continue
    // A chat that names no session is the conversation pool's, and only the
    // leading pane renders the pool. Saved beside it, the same conversation
    // would come back on both sides of the split, so the pane is dropped —
    // unless an overlay is what it was really holding.
    if (pane.base?.name === 'chat' && !pane.base.params.sessionId) {
      pane.base = null
      if (!pane.overlay) continue
    }
    panes.push(pane)
  }

  const focusIndex = Number(params.get('f') ?? 0)
  const focused = panes[Number.isInteger(focusIndex) ? focusIndex : 0] ?? panes[0]
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
