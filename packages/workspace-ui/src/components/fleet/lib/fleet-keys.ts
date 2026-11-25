/**
 * Arrow keys on the host map: from one host to the nearest host in that
 * direction, as the person sees them. It reads the places the hosts are drawn at,
 * so a card, a tile in a full zone, and this device are one set of stops.
 */

export type FleetDirection = 'up' | 'down' | 'left' | 'right'

/** The direction of an arrow key; null for any other key. */
export function arrowDirection(key: string): FleetDirection | null {
  switch (key) {
    case 'ArrowUp': return 'up'
    case 'ArrowDown': return 'down'
    case 'ArrowLeft': return 'left'
    case 'ArrowRight': return 'right'
    default: return null
  }
}

/** A host as it is drawn: its box in any one coordinate space. */
export interface FleetStop {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** How much more a step sideways counts than a step along: an arrow keeps to its row or column. */
const SIDEWAYS_WEIGHT = 3

/**
 * The host one arrow key moves to from `fromId`; null when nothing lies that way.
 * A host is that way when its center is past the edge of the current one, so the
 * hosts of one row or column are stepped in order, and the nearest one wins.
 */
export function nextFleetStop(stops: readonly FleetStop[], fromId: string | null, direction: FleetDirection): string | null {
  const from = stops.find((stop) => stop.id === fromId)
  if (!from) return stops[0]?.id ?? null
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  let best: { id: string; score: number } | null = null
  for (const stop of stops) {
    if (stop.id === from.id) continue
    const center = { x: stop.x + stop.w / 2, y: stop.y + stop.h / 2 }
    const along = direction === 'up' ? from.y - center.y
      : direction === 'down' ? center.y - (from.y + from.h)
        : direction === 'left' ? from.x - center.x
          : center.x - (from.x + from.w)
    if (along <= 0) continue
    const sideways = direction === 'up' || direction === 'down' ? Math.abs(center.x - fromCenter.x) : Math.abs(center.y - fromCenter.y)
    const score = along + sideways * SIDEWAYS_WEIGHT
    if (!best || score < best.score) best = { id: stop.id, score }
  }
  return best?.id ?? null
}

/**
 * The host Find goes to: the `index`th match in name order, round again past the
 * last. Enter in Find steps through them.
 */
export function foundStop<T extends { label: string }>(matches: readonly T[], index: number): T | null {
  if (!matches.length) return null
  const sorted = [...matches].sort((a, b) => a.label.localeCompare(b.label))
  return sorted[((index % sorted.length) + sorted.length) % sorted.length]!
}
