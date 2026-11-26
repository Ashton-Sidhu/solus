import type { ReachedMachine } from '@solus/client-core/reached-machines'
import type { FleetMachine, Point } from './fleet-model'

/**
 * Which of your hosts reach each other, as lines on the host map, and what a drop
 * of one host onto another does. A person's hosts reach each other with no step,
 * through introductions; the map shows that reach, its health, and lets the person
 * introduce two hosts again or forget an introduction.
 */

/** How one way of a reach is doing. An introduction sends no health, so it reads as working. */
export type ReachHealth = 'working' | 'unknown' | 'expiring' | 'failing' | 'expired'

export function reachHealthOf(machine: ReachedMachine): ReachHealth {
  if (machine.way === 'introduced' || !machine.health) return 'working'
  switch (machine.health.kind) {
    case 'unknown': return 'unknown'
    case 'working': return machine.health.expiresInDays === null ? 'working' : 'expiring'
    case 'failing': return 'failing'
    case 'expired': return 'expired'
  }
}

const TROUBLE = { working: 0, unknown: 1, expiring: 2, failing: 3, expired: 4 } satisfies Record<ReachHealth, number>

export const worseReachHealth = (left: ReachHealth, right: ReachHealth): ReachHealth => (TROUBLE[left] >= TROUBLE[right] ? left : right)

export function reachNeedsAttention(health: ReachHealth): boolean {
  return TROUBLE[health] >= TROUBLE.expiring
}

/** How each health is drawn. A healthy line stays neutral so trouble stands out; each kind of trouble has its own dash. */
export const REACH_STYLES = {
  working: { color: 'color-mix(in oklch, var(--foreground) 42%, transparent)', dash: null, width: 1.5 },
  unknown: { color: 'color-mix(in oklch, var(--foreground) 28%, transparent)', dash: null, width: 1 },
  expiring: { color: 'var(--warning)', dash: '10 3', width: 1.5 },
  failing: { color: 'var(--solus-status-error)', dash: '8 3 1 3', width: 1.75 },
  expired: { color: 'color-mix(in oklch, var(--solus-status-error) 75%, transparent)', dash: '1 5', width: 1.75 },
} satisfies Record<ReachHealth, { color: string; dash: string | null; width: number }>

export const REACH_HEALTH_LABELS = {
  working: 'Working',
  unknown: 'Health unknown',
  expiring: 'Expires soon',
  failing: 'Failing',
  expired: 'Expired',
} satisfies Record<ReachHealth, string>

/** Two hosts that reach each other, one way or both, drawn as one line. */
export interface ReachEdge {
  /** Both server ids, in a fixed order. */
  id: string
  a: string
  b: string
  /** How `a` reaches `b`; null when it does not. */
  forward: ReachedMachine | null
  /** How `b` reaches `a`; null when it does not. */
  back: ReachedMachine | null
  /** The worse of the two ways: a line wears its most troubled way. */
  health: ReachHealth
}

/** The machines one host reaches, as its owner reads them (`reachedMachinesStore`). */
export interface ReachSource {
  serverId: string
  reached: readonly ReachedMachine[]
}

export const reachEdgeId = (left: string, right: string): string => (left < right ? `${left}\n${right}` : `${right}\n${left}`)

/**
 * One edge for each two hosts on the map where either reaches the other. A reached
 * machine that is not on the map (another person's host, an old record) has no line.
 */
export function reachEdges(sources: readonly ReachSource[], serverIdOf: (installationId: string) => string | undefined): ReachEdge[] {
  const edges = new Map<string, ReachEdge>()
  for (const source of sources) {
    for (const reached of source.reached) {
      const target = serverIdOf(reached.installationId)
      if (!target || target === source.serverId) continue
      const id = reachEdgeId(source.serverId, target)
      const [a, b] = source.serverId < target ? [source.serverId, target] : [target, source.serverId]
      const edge: ReachEdge = edges.get(id) ?? { id, a, b, forward: null, back: null, health: 'working' }
      if (source.serverId === a) edge.forward = reached
      else edge.back = reached
      edge.health = [edge.forward, edge.back].reduce<ReachHealth>((worst, way) => (way ? worseReachHealth(worst, reachHealthOf(way)) : worst), 'working')
      edges.set(id, edge)
    }
  }
  return [...edges.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export const isTwoWay = (edge: ReachEdge): boolean => edge.forward !== null && edge.back !== null

/** The hosts one step from `serverId`: what selecting it lights. A reach is not followed through. */
export function reachNeighbors(edges: readonly ReachEdge[], serverId: string): Set<string> {
  const neighbors = new Set<string>()
  for (const edge of edges) {
    if (edge.a === serverId) neighbors.add(edge.b)
    else if (edge.b === serverId) neighbors.add(edge.a)
  }
  return neighbors
}

/* ---------- lines ---------- */

/** More lanes than this push the zone too far in: the longest lines share the outermost lane. */
export const MAX_REACH_LANES = 5

/**
 * The lane of each line that joins two cards: a line runs out to its lane, along
 * it, and back in. Short lines take the lanes nearest the cards, and two lines
 * share a lane only where they do not overlap, so no line runs over another.
 */
/** The lane of each line drawn, by edge id, and how many lanes they take. */
export interface ReachLaneAssignment {
  lanes: Map<string, number>
  count: number
}

export function reachLanes(edges: readonly ReachEdge[], cardY: ReadonlyMap<string, number>): ReachLaneAssignment {
  const drawn = edges.flatMap((edge) => {
    const ya = cardY.get(edge.a)
    const yb = cardY.get(edge.b)
    return ya === undefined || yb === undefined ? [] : [{ id: edge.id, top: Math.min(ya, yb), bottom: Math.max(ya, yb) }]
  }).sort((left, right) => (left.bottom - left.top) - (right.bottom - right.top) || left.top - right.top)
  const taken: Array<Array<{ top: number; bottom: number }>> = []
  const lanes = new Map<string, number>()
  for (const line of drawn) {
    let lane = taken.findIndex((spans) => spans.every((span) => line.bottom < span.top || line.top > span.bottom))
    if (lane === -1) lane = Math.min(taken.length, MAX_REACH_LANES - 1)
    ;(taken[lane] ??= []).push(line)
    lanes.set(line.id, lane)
  }
  return { lanes, count: taken.length }
}

export interface ReachEnd {
  serverId: string
  point: Point
  /** The way into this host exists, so the line ends in an arrowhead here. */
  isReached: boolean
}

export interface ReachPath {
  edge: ReachEdge
  d: string
  ends: [ReachEnd, ReachEnd]
}

/**
 * The lines between cards. `cards` gives each card's outer edge and middle,
 * `laneX` the place of each lane, and `endSpread` the distance between two lines
 * that meet one card, all in the map's percent units.
 */
export function reachPaths(
  edges: readonly ReachEdge[],
  cards: ReadonlyMap<string, { edge: number; y: number }>,
  lanes: ReadonlyMap<string, number>,
  laneX: (lane: number) => number,
  endSpread: number,
): ReachPath[] {
  const drawn = edges.filter((edge) => lanes.has(edge.id) && cards.has(edge.a) && cards.has(edge.b))
  // The lines into one card spread across it, in the order of the cards at their other ends.
  const endsOf = new Map<string, Array<{ edgeId: string; otherY: number }>>()
  for (const edge of drawn) {
    for (const [here, there] of [[edge.a, edge.b], [edge.b, edge.a]] as const) {
      const list = endsOf.get(here) ?? []
      list.push({ edgeId: edge.id, otherY: cards.get(there)!.y })
      endsOf.set(here, list)
    }
  }
  for (const list of endsOf.values()) list.sort((left, right) => left.otherY - right.otherY)
  const endPoint = (serverId: string, edgeId: string): Point => {
    const card = cards.get(serverId)!
    const list = endsOf.get(serverId)!
    const index = list.findIndex((entry) => entry.edgeId === edgeId)
    return { x: card.edge, y: card.y + (index - (list.length - 1) / 2) * endSpread }
  }
  return drawn.map((edge) => {
    const from = endPoint(edge.a, edge.id)
    const to = endPoint(edge.b, edge.id)
    const x = laneX(lanes.get(edge.id)!)
    return {
      edge,
      d: `M ${from.x} ${from.y} L ${x} ${from.y} L ${x} ${to.y} L ${to.x} ${to.y}`,
      ends: [
        { serverId: edge.a, point: from, isReached: edge.back !== null },
        { serverId: edge.b, point: to, isReached: edge.forward !== null },
      ],
    }
  })
}

/* ---------- introducing two hosts ---------- */

/** Why a host cannot take part in an introduction from this device; null when it can. */
export function introduceBlock(machine: FleetMachine, isLocalOwner: boolean): string | null {
  if (machine.zone === 'cloud') return `${machine.label} is a Solus Cloud machine. It reaches your hosts through your account.`
  if (machine.zone === 'shared') return `${machine.label} is shared with you. Only its owner can introduce it.`
  if (!isLocalOwner) return `This device is not the owner of ${machine.label}, so it cannot introduce it.`
  if (machine.state !== 'running' && machine.state !== 'idle') return `${machine.label} does not answer now.`
  if (!machine.installationId) return `${machine.label} has not said which host it is yet.`
  return null
}

export type IntroduceAction =
  | { kind: 'introduce'; sourceId: string; targetIds: string[]; skipped: string[] }
  | { kind: 'explain'; message: string }

/**
 * What a drop of `sourceId`'s handle on `dropId` does. A drop on one of several
 * selected hosts introduces the source to each of them; a drop elsewhere, to that
 * one host. Hosts that cannot take part are skipped and named; when none can, the
 * drop says why in place. Null for a drop on the source itself.
 */
export function introduceAction(input: {
  sourceId: string
  dropId: string
  selected: ReadonlySet<string>
  edges: readonly ReachEdge[]
  blockOf: (serverId: string) => string | null
  labelOf: (serverId: string) => string
}): IntroduceAction | null {
  const { sourceId, dropId, selected, edges, blockOf, labelOf } = input
  if (dropId === sourceId) return null
  const sourceBlock = blockOf(sourceId)
  if (sourceBlock) return { kind: 'explain', message: sourceBlock }
  const targets = (selected.has(dropId) && selected.size > 1 ? [...selected] : [dropId]).filter((serverId) => serverId !== sourceId)
  const twoWay = new Set(edges.filter(isTwoWay).map((edge) => edge.id))
  const blocked = targets.flatMap((serverId) => {
    const block = blockOf(serverId)
    return block ? [block] : []
  })
  const open = targets.filter((serverId) => !blockOf(serverId) && !twoWay.has(reachEdgeId(sourceId, serverId)))
  if (open.length) return { kind: 'introduce', sourceId, targetIds: open, skipped: blocked }
  if (blocked.length) return { kind: 'explain', message: blocked[0]! }
  const names = targets.map(labelOf).join(', ')
  return { kind: 'explain', message: `${labelOf(sourceId)} and ${names} already reach each other.` }
}
