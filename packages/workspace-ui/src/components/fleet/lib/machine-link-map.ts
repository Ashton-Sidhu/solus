import { machineLinkStateText, machineLinkTone, worseLinkState, type MachineLinkState, type MachineLinkTone, type MachineLinkView } from '@solus/client-core/host-linking'
import { CARD_HEIGHT, linkPath, MAP_HEIGHT, type MapLayout, type Point } from './fleet-model'

/**
 * Machine links on the map (docs/plans/host-fleet.md D13): each link one line
 * from the card of the machine that holds it to the card of the machine it
 * reaches, with an arrowhead at each end that a link reaches. Pure, so the map
 * and the tests read the same answers.
 */

/** Where a line meets one machine on the map. */
interface Anchor {
  /** The middle of the card, the zone edge of a full zone, or this device. */
  at: Point
  halfWidth: number
  /** The side of the map the machine is on; this device is the center. */
  side: 'left' | 'right' | 'center'
}

/** An arrowhead: its tip, and whether it points right (1) or left (-1). */
export interface LinkArrow {
  at: Point
  dir: 1 | -1
}

export interface MapLinkLine {
  /** The id of its `MachineLinkView`. */
  id: string
  d: string
  /** Of the direction in more trouble, for a two-way link. */
  tone: MachineLinkTone
  arrows: LinkArrow[]
  /** The installation ids of its two ends. */
  ends: [string, string]
}

/** How far a line between two cards of one side bows out past their outer edges, in percent of the map's width. */
const BOW = 2.5
/** A line across the map runs a quarter card below the middle of each card, so it does not lie on the route line there. */
const ACROSS_OFFSET = (CARD_HEIGHT / 4 / MAP_HEIGHT) * 100

/** Each machine on the map by its installation id: a card, a full zone's edge, or this device. */
function anchors(map: MapLayout, deviceId: string | null): Map<string, Anchor> {
  const found = new Map<string, Anchor>()
  if (deviceId) found.set(deviceId, { at: { x: map.hub.x, y: map.hub.y }, halfWidth: map.hub.w / 2, side: 'center' })
  for (const zone of map.zones) {
    const side = zone.zone.isViaTunnel ? 'right' : 'left'
    if (zone.isFull) {
      for (const machine of zone.hosts) {
        if (machine.installationId) found.set(machine.installationId, { at: zone.port, halfWidth: 0, side })
      }
      continue
    }
    for (const row of zone.rows) {
      const id = row.slot.kind === 'host' ? row.slot.machine.installationId : row.slot.kind === 'linked' ? row.slot.machine.installationId : null
      if (id) found.set(id, { at: row.at, halfWidth: map.cardWidth / 2, side })
    }
  }
  return found
}

/**
 * Two machines on one side: a bow past their outer edges, clear of the route
 * lines on their inner edges. Else a line from the inner edge of one to the
 * inner edge of the other, which passes behind this device.
 */
function linkGeometry(from: Anchor, to: Anchor, isTwoWay: boolean): { d: string; arrows: LinkArrow[] } {
  if (from.side === to.side && from.side !== 'center') {
    const out = from.side === 'left' ? -1 : 1
    const start = { x: from.at.x + out * from.halfWidth, y: from.at.y }
    const end = { x: to.at.x + out * to.halfWidth, y: to.at.y }
    const bend = (from.side === 'left' ? Math.min(start.x, end.x) : Math.max(start.x, end.x)) + out * BOW
    const d = `M ${start.x} ${start.y} C ${bend} ${start.y}, ${bend} ${end.y}, ${end.x} ${end.y}`
    // The line enters each card from outside it.
    const dir = (out === -1 ? 1 : -1) as 1 | -1
    return { d, arrows: [{ at: end, dir }, ...(isTwoWay ? [{ at: start, dir }] : [])] }
  }
  const towards = to.at.x >= from.at.x ? 1 : -1
  const start = { x: from.at.x + towards * from.halfWidth, y: from.at.y + ACROSS_OFFSET }
  const end = { x: to.at.x - towards * to.halfWidth, y: to.at.y + ACROSS_OFFSET }
  return {
    d: linkPath(start, end),
    arrows: [{ at: end, dir: towards as 1 | -1 }, ...(isTwoWay ? [{ at: start, dir: -towards as 1 | -1 }] : [])],
  }
}

/** The lines of every link whose two ends are on the map. */
export function mapLinkLines(map: MapLayout, views: readonly MachineLinkView[], deviceId: string | null): MapLinkLine[] {
  const placed = anchors(map, deviceId)
  return views.flatMap((view) => {
    const from = placed.get(view.sourceId)
    const to = placed.get(view.targetId)
    // Two members of one full zone meet at one point: there is no line to draw.
    if (!from || !to || (from.at.x === to.at.x && from.at.y === to.at.y)) return []
    const { d, arrows } = linkGeometry(from, to, !!view.back)
    return [{ id: view.id, d, tone: machineLinkTone(linkState(view)), arrows, ends: [view.sourceId, view.targetId] }]
  })
}

/** The state a link shows: of the direction in more trouble, for a two-way link. */
export function linkState(view: MachineLinkView): MachineLinkState {
  return view.back ? worseLinkState(view.state, view.back.state) : view.state
}

/** What one machine's links come to: on its card, and in the area below the map. */
export interface MachineLinkSummary {
  count: number
  tone: MachineLinkTone
  /** "NAS: Reachable · Mac mini: Failing", the other end of each link and its state. */
  text: string
}

const TONE_RANK = { bad: 0, warn: 1, unknown: 2, ok: 3 } satisfies Record<MachineLinkTone, number>

export function machineLinkSummary(views: readonly MachineLinkView[], installationId: string | null): MachineLinkSummary | null {
  if (!installationId) return null
  const own = views.filter((view) => view.sourceId === installationId || view.targetId === installationId)
  if (!own.length) return null
  const tones = own.map((view) => machineLinkTone(linkState(view)))
  return {
    count: own.length,
    tone: tones.reduce((worst, tone) => (TONE_RANK[tone] < TONE_RANK[worst] ? tone : worst), 'ok' as MachineLinkTone),
    text: own.map((view) => {
      const other = view.sourceId === installationId ? view.targetLabel : view.sourceLabel
      const arrow = view.back ? '↔' : view.sourceId === installationId ? '→' : '←'
      return `${arrow} ${other}: ${machineLinkStateText(linkState(view))}`
    }).join(' · '),
  }
}
