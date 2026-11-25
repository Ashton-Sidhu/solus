import type { FoundMachine } from './discover'
import { isZoneFull, mapLayout, OPEN_ZONE_CARDS, ZONES, type FleetZoneId, type MachinesByZone, type MapLayout, type Point, type ZoneAnswers } from './fleet-model'
import { reachLanes, reachPaths, type ReachEdge, type ReachPath } from './fleet-reach'
import { fanRoutes, type FannedRoutes, type WireRoute } from './fleet-routes'

/** The space between two wires where they leave this device, and where they reach a card, in rem. */
const WIRE_SPREAD = { start: 0.3, end: 0.6 }
/** The space between two lines between your hosts where they meet one card, in rem. */
const REACH_END_SPREAD = 0.55

export interface FleetScene {
  map: MapLayout
  wires: Map<string, FannedRoutes>
  reachPaths: ReachPath[]
}

/**
 * Everything the map draws for one shape of the fleet: the layout, with room for
 * the lanes of the lines between your hosts; a wire for each route of each host
 * with a card; and those lines. Only hosts with a card have wires and lines; a
 * host shown as a tile is reached through its zone's one line.
 */
export function fleetScene(input: {
  byZone: MachinesByZone
  found: readonly FoundMachine[]
  widthRem: number
  answers?: ZoneAnswers
  open: ReadonlySet<FleetZoneId>
  edges: readonly ReachEdge[]
  routesOf: (serverId: string) => readonly WireRoute[]
}): FleetScene {
  const { byZone, found, widthRem, answers, open, edges, routesOf } = input
  // The lines run only between cards of Your machines: their order is the order of the cards.
  const ownZone = ZONES.find((zone) => zone.id === 'own')!
  const ownShowsCards = !isZoneFull(ownZone, byZone.own.length) || open.has('own')
  const cardOrder = new Map(ownShowsCards ? byZone.own.slice(0, OPEN_ZONE_CARDS).map((machine, index) => [machine.serverId, index] as const) : [])
  const { lanes, count } = reachLanes(edges, cardOrder)
  const map = mapLayout(byZone, found, widthRem, answers, { open, reachLanes: count })
  const down = (rem: number) => (rem / map.height) * 100

  const wires = new Map<string, FannedRoutes>()
  const cards = new Map<string, { edge: number; y: number }>()
  for (const zone of map.zones) {
    for (const row of zone.rows) {
      if (row.slot.kind !== 'host') continue
      const { serverId } = row.slot.machine
      wires.set(serverId, fanRoutes(routesOf(serverId), zone.linkStart, row.port, { start: down(WIRE_SPREAD.start), end: down(WIRE_SPREAD.end) }))
      if (zone.zone.id === 'own') cards.set(serverId, { edge: row.at.x - map.cardWidth / 2, y: row.at.y })
    }
  }
  const paths = reachPaths(edges, cards, lanes, (lane) => map.lanes.first + lane * map.lanes.step, down(REACH_END_SPREAD))
  return { map, wires, reachPaths: paths }
}

/** A point of the map in px, as the map's percent units. */
export function scenePercent(point: Point, scene: { w: number; h: number }): Point {
  return { x: (point.x / scene.w) * 100, y: (point.y / scene.h) * 100 }
}

/** Where a host's card sits on the map, in px; null for a host without a card. */
export function cardCenter(map: MapLayout, serverId: string, scene: { w: number; h: number }): Point | null {
  for (const zone of map.zones) {
    const row = zone.rows.find((entry) => entry.slot.kind === 'host' && entry.slot.machine.serverId === serverId)
    if (row) return { x: (row.at.x / 100) * scene.w, y: (row.at.y / 100) * scene.h }
  }
  return null
}

/** The top of a zone on the map, in px: what stays put when the zone opens or folds. */
export function zoneTop(map: MapLayout, zoneId: FleetZoneId, scene: { w: number; h: number }): Point {
  const zone = map.zones.find((entry) => entry.zone.id === zoneId)!
  return { x: (zone.box.x / 100) * scene.w, y: (zone.box.y / 100) * scene.h }
}
