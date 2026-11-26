import type { PersonalSettings } from '@solus/contracts/settings'
import { isSamePin, type SidebarAppPin } from '@solus/client-core/sidebar-apps'
export { isSamePin, isAppPinned, withAppPinned, type SidebarAppPin } from '@solus/client-core/sidebar-apps'

/**
 * What the places column of the sidebar shows (docs/plans/sidebar-places-and-sky.md,
 * "Customizing the column"). Sessions is always first. Below it are the Solus
 * places, in the order the person chose, then a divider and the apps they
 * pinned. Both are the synced personal settings `sidebarPlaces` and
 * `sidebarApps`. The stored lists keep ids this client does not know, so an
 * older and a newer client never erase each other's choices.
 */

export type SidebarPlacesLayout = PersonalSettings['sidebarPlaces']

export const SIDEBAR_PLACES = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'automations', label: 'Automations' },
  { id: 'insights', label: 'Insights' },
  { id: 'prs', label: 'Pull requests' },
  { id: 'tasks', label: 'Issues' },
  { id: 'search', label: 'Search' },
] as const

export type SidebarPlaceId = (typeof SIDEBAR_PLACES)[number]['id']
export type SidebarPlace = (typeof SIDEBAR_PLACES)[number]

/** The row a right-click opened the column's menu on, with its neighbours in the column for Move up and Move down. */
export type SidebarPlacesMenuTarget =
  | { kind: 'place'; id: SidebarPlaceId; label: string; above: SidebarPlaceId | null; below: SidebarPlaceId | null }
  | { kind: 'app'; pin: SidebarAppPin; label: string; above: SidebarAppPin | null; below: SidebarAppPin | null }

/** Every place this client knows, in the person's order. A place the order does not name follows in the default order. */
export function orderedPlaces(layout: SidebarPlacesLayout): SidebarPlace[] {
  const rank = (place: SidebarPlace) => {
    const index = layout.order.indexOf(place.id)
    return index === -1 ? layout.order.length + SIDEBAR_PLACES.indexOf(place) : index
  }
  return [...SIDEBAR_PLACES].sort((a, b) => rank(a) - rank(b))
}

export function isPlaceShown(layout: SidebarPlacesLayout, id: SidebarPlaceId): boolean {
  return !layout.hidden.includes(id)
}

/** The places that show, in order. */
export function shownPlaces(layout: SidebarPlacesLayout): SidebarPlace[] {
  return orderedPlaces(layout).filter((place) => isPlaceShown(layout, place.id))
}

/** The layout after one place shows or hides. Every other id stays, in its order. */
export function withPlaceShown(layout: SidebarPlacesLayout, id: SidebarPlaceId, shown: boolean): SidebarPlacesLayout {
  const hidden = layout.hidden.filter((hiddenId) => hiddenId !== id)
  return { order: [...layout.order], hidden: shown ? hidden : [...hidden, id] }
}

/**
 * The layout after `id` moves onto `target`: after it when it came from
 * above, before it when it came from below. A drop on a row and Move up or
 * Move down (onto the neighbour) are the same move.
 */
export function withPlaceMoved(layout: SidebarPlacesLayout, id: SidebarPlaceId, target: SidebarPlaceId): SidebarPlacesLayout {
  const known = new Set<string>(SIDEBAR_PLACES.map((place) => place.id))
  const order = movedOnto(orderedPlaces(layout).map((place) => place.id), id, target, (a, b) => a === b)
  return { order: [...order, ...layout.order.filter((placeId) => !known.has(placeId))], hidden: [...layout.hidden] }
}

/** A place hidden or moved: the layout is not the default. */
export function isPlacesLayoutChanged(layout: SidebarPlacesLayout): boolean {
  return layout.hidden.length > 0 || orderedPlaces(layout).some((place, index) => place !== SIDEBAR_PLACES[index])
}

// ─── Pinned apps ───

/** The pin of an app. A server id names a host only on this client, so the pin names the host's installation id. */
export function appPinOf(serverId: string, appId: string, host: { id: string; installationId?: string } | null): SidebarAppPin {
  return { host: host?.installationId || serverId, appId }
}

/** The pins after `pin` moves onto `target`, as `withPlaceMoved`. A pin of a host that is not connected keeps its place. */
export function withAppMoved(pins: readonly SidebarAppPin[], pin: SidebarAppPin, target: SidebarAppPin): SidebarAppPin[] {
  return movedOnto(pins, pin, target, isSamePin).map((moved) => ({ ...moved }))
}

/** The rows the pins name, in pin order. A pin whose app no connected host has does not show, and stays stored. */
export function pinnedRows<Row extends { serverId: string; app: { id: string } }>(
  pins: readonly SidebarAppPin[],
  rows: readonly Row[],
  pinOfRow: (row: Row) => SidebarAppPin,
): { pin: SidebarAppPin; row: Row }[] {
  return pins.flatMap((pin) => {
    const row = rows.find((candidate) => isSamePin(pinOfRow(candidate), pin))
    return row ? [{ pin, row }] : []
  })
}

/** The menu target of the shown place at `index`, with the places beside it in the column. */
export function placeMenuTarget(shown: readonly SidebarPlace[], index: number): SidebarPlacesMenuTarget | null {
  const place = shown[index]
  if (!place) return null
  return { kind: 'place', id: place.id, label: place.label, above: shown[index - 1]?.id ?? null, below: shown[index + 1]?.id ?? null }
}

/** The menu target of the pinned app at `index`, with the pinned apps beside it in the column. */
export function appMenuTarget(pinned: readonly { pin: SidebarAppPin; label: string }[], index: number): SidebarPlacesMenuTarget | null {
  const app = pinned[index]
  if (!app) return null
  return { kind: 'app', pin: app.pin, label: app.label, above: pinned[index - 1]?.pin ?? null, below: pinned[index + 1]?.pin ?? null }
}

// ─── Drag to reorder ───

/** The gap a dragged button goes into: the number of buttons of its group whose middle is above the pointer. */
export function insertionIndex(buttons: readonly { top: number; bottom: number }[], pointerY: number): number {
  return buttons.filter((button) => (button.top + button.bottom) / 2 < pointerY).length
}

/** Where the drop line shows for a gap: half way between two buttons, or just below the last one. */
export function dropLineY(buttons: readonly { top: number; bottom: number }[], insertion: number): number | null {
  const below = buttons[insertion]
  const above = buttons[insertion - 1]
  if (below && above) return (above.bottom + below.top) / 2
  if (below) return below.top - 2
  return above ? above.bottom + 2 : null
}

/**
 * The button that a drop into gap `insertion` moves the dragged button (at
 * `from`) onto, for `withPlaceMoved` and `withAppMoved`. Null when the drop
 * leaves it where it is: the gaps on each side of it.
 */
export function dropTargetAt<T>(shown: readonly T[], from: number, insertion: number): T | null {
  if (from === -1) return null
  if (insertion > from + 1) return shown[Math.min(insertion, shown.length) - 1] ?? null
  if (insertion < from) return shown[insertion] ?? null
  return null
}

function movedOnto<T>(list: readonly T[], item: T, target: T, same: (a: T, b: T) => boolean): T[] {
  const from = list.findIndex((candidate) => same(candidate, item))
  const to = list.findIndex((candidate) => same(candidate, target))
  if (from === -1 || to === -1 || from === to) return [...list]
  // With the item out of the list, index `to` is after the target when the item came from above, and before it when it came from below.
  const next = list.filter((_, index) => index !== from)
  next.splice(to, 0, list[from])
  return next
}
