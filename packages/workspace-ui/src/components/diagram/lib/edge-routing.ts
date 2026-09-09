import { facingAnchor, type AnchorSide } from '@solus/contracts/diagram-edge-anchor'
import type { DiagramEdge } from '@solus/contracts/diagram-types'

export interface Point { x: number; y: number }
export interface RouteBox extends Point { width: number; height: number }
export interface RouteNode extends RouteBox { id: string; group?: boolean }
export interface RouteEdge extends DiagramEdge { labelSize?: { width: number; height: number } }
export interface EdgeDrawing {
  points: Point[]
  path: string
  label: Point
  anchor: Point
  sourceSide: AnchorSide
  targetSide: AnchorSide
  bend?: { start: Point; end: Point; axis: 'x' | 'y'; offset: number }
}
const GAP = 16
const directions = {
  left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 },
} satisfies Record<AnchorSide, Point>
export function overlaps(a: RouteBox, b: RouteBox, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
}
function segmentHits(a: Point, b: Point, box: RouteBox): boolean {
  // Slab intersection also handles explicitly straight (diagonal) connectors.
  let lo = 0, hi = 1
  for (const axis of ['x', 'y'] as const) {
    const d = b[axis] - a[axis]
    const min = box[axis] + 0.01
    const max = box[axis] + (axis === 'x' ? box.width : box.height) - 0.01
    if (d === 0) { if (a[axis] < min || a[axis] > max) return false }
    else { const t1 = (min - a[axis]) / d, t2 = (max - a[axis]) / d; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)) }
  }
  return lo <= hi
}
function endpoint(node: RouteNode, toward: RouteNode, handle?: string): Point & { side: AnchorSide } {
  const key = handle?.[0]
  const side = key === 'l' ? 'left' : key === 'r' ? 'right' : key === 't' ? 'top' : key === 'b' ? 'bottom' : undefined
  if (!side) return facingAnchor(node, toward)
  return { side, x: side === 'left' ? node.x : side === 'right' ? node.x + node.width : node.x + node.width / 2,
    y: side === 'top' ? node.y : side === 'bottom' ? node.y + node.height : node.y + node.height / 2 }
}
function compact(points: Point[]): Point[] {
  return points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y)
}
function distance(a: Point, b: Point) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) }
function pathFor(points: Point[], rounded: boolean): string {
  if (!points.length) return ''
  let path = `M${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) {
    const p = points[i], prev = points[i - 1], next = points[i + 1]
    const radius = rounded && next ? Math.min(6, distance(prev, p) / 2, distance(p, next) / 2) : 0
    if (!radius || !next) { path += `L${p.x} ${p.y}`; continue }
    const before = { x: p.x + Math.sign(prev.x - p.x) * radius, y: p.y + Math.sign(prev.y - p.y) * radius }
    const after = { x: p.x + Math.sign(next.x - p.x) * radius, y: p.y + Math.sign(next.y - p.y) * radius }
    path += `L${before.x} ${before.y}Q${p.x} ${p.y} ${after.x} ${after.y}`
  }
  return path
}
function segmentBox(a: Point, b: Point): RouteBox {
  return { x: Math.min(a.x, b.x) - 2, y: Math.min(a.y, b.y) - 2, width: Math.abs(a.x - b.x) + 4, height: Math.abs(a.y - b.y) + 4 }
}
/** Shared, deterministic routing for the editor, preview and image stage. */
export function routeEdges(nodes: RouteNode[], edges: RouteEdge[]): Map<string, EdgeDrawing> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const obstacles = nodes.filter(n => !n.group)
  const channelsX = [...new Set(obstacles.flatMap(n => [n.x - GAP, n.x + n.width + GAP]))]
  const channelsY = [...new Set(obstacles.flatMap(n => [n.y - GAP, n.y + n.height + GAP]))]
  const ink: RouteBox[] = []
  const result = new Map<string, EdgeDrawing>()
  const ordered = [...edges].sort((a, b) => a.id.localeCompare(b.id))
  const ends = ordered.flatMap(edge => {
    const source = byId.get(edge.source), target = byId.get(edge.target)
    if (!source || !target) return []
    return [{ edge, source, target, s: endpoint(source, target, edge.sourceHandle || (source === target ? 'r-source' : undefined)), t: endpoint(target, source, edge.targetHandle || (source === target ? 't-target' : undefined)) }]
  })
  spreadEndpoints(ends)
  for (const { edge, source, target, s, t } of ends) {
    const { points, bend } = chooseRoute({ edge, source, target, s, t }, obstacles, ink, channelsX, channelsY)
    const segments = points.slice(1).map((p, i) => ({ a: points[i], b: p, length: distance(points[i], p) })).sort((a, b) => b.length - a.length)
    const longest = segments[0] ?? { a: s, b: t }
    const anchor = { x: (longest.a.x + longest.b.x) / 2, y: (longest.a.y + longest.b.y) / 2 }
    result.set(edge.id, { points, path: pathFor(points, edge.route !== 'step' && edge.route !== 'straight'), anchor, label: anchor, sourceSide: s.side, targetSide: t.side, bend })
    for (let i = 1; i < points.length; i++) ink.push(segmentBox(points[i - 1], points[i]))
  }
  placeLabels(nodes, ordered, result, ink)
  return result
}

interface RouteEnds {
  edge: RouteEdge
  source: RouteNode
  target: RouteNode
  s: Point & { side: AnchorSide }
  t: Point & { side: AnchorSide }
}
function spreadEndpoints(ends: RouteEnds[]) {
  // Floating ends share the side, not a single pixel. Explicit handles stay pinned.
  for (const item of ends) {
    for (const end of ['s', 't'] as const) {
      if (end === 's' ? item.edge.sourceHandle : item.edge.targetHandle) continue
      const node = end === 's' ? item.source : item.target, anchor = item[end]
      const siblings = ends.flatMap(other => (['s', 't'] as const).filter(k =>
        (k === 's' ? other.source : other.target).id === node.id && other[k].side === anchor.side,
      ).map(k => ({ item: other, end: k })))
      const index = siblings.findIndex(s => s.item === item && s.end === end)
      const fraction = (index + 1) / (siblings.length + 1)
      if (anchor.side === 'left' || anchor.side === 'right') anchor.y = node.y + node.height * fraction
      else anchor.x = node.x + node.width * fraction
    }
  }
}
function chooseRoute({ edge, source, target, s, t }: RouteEnds, obstacles: RouteNode[], ink: RouteBox[], channelsX: number[], channelsY: number[]): Pick<EdgeDrawing, 'points' | 'bend'> {
  const sd = directions[s.side], td = directions[t.side]
  const a = { x: s.x + sd.x * GAP, y: s.y + sd.y * GAP }, b = { x: t.x + td.x * GAP, y: t.y + td.y * GAP }
  let points: Point[]
  let bend: EdgeDrawing['bend']
  if (edge.route === 'straight') points = [s, t]
  else {
    const horizontal = edge.bendAxis ? edge.bendAxis === 'x' : sd.x !== 0
    const center = { x: (a.x + b.x) / 2 + (horizontal ? edge.bendOffset ?? 0 : 0), y: (a.y + b.y) / 2 + (!horizontal ? edge.bendOffset ?? 0 : 0) }
    const candidates: { points: Point[]; axis: 'x' | 'y'; offset: number }[] = []
    const addX = (x: number) => candidates.push({ points: [s, a, { x, y: a.y }, { x, y: b.y }, b, t], axis: 'x', offset: x - (a.x + b.x) / 2 })
    const addY = (y: number) => candidates.push({ points: [s, a, { x: a.x, y }, { x: b.x, y }, b, t], axis: 'y', offset: y - (a.y + b.y) / 2 })
    if (horizontal) addX(center.x); else addY(center.y)
    if (edge.bendOffset === undefined) {
      addX(center.x); addY(center.y)
      for (const x of channelsX) addX(x)
      for (const y of channelsY) addY(y)
    }
    let best = Infinity
    points = candidates[0].points
    for (const candidate of candidates) {
      const path = compact(candidate.points)
      const cost = routeCost(path, source.id, target.id, obstacles, ink, best)
      if (cost < best) {
        best = cost; points = path
        bend = { start: candidate.points[2], end: candidate.points[3], axis: candidate.axis, offset: candidate.offset }
      }
    }
  }
  return { points, bend }
}
function routeCost(path: Point[], sourceId: string, targetId: string, obstacles: RouteNode[], ink: RouteBox[], best: number): number {
  let cost = path.length * 4 + path.slice(1).reduce((sum, point, i) => sum + distance(path[i], point), 0)
  // Length is a lower bound. Most edges already have a short clear route;
  // reject longer candidates before checking every obstacle and connector.
  if (cost >= best) return cost
  for (let i = 1; i < path.length && cost < best; i++) {
    for (const n of obstacles) {
      if ((i === 1 && n.id === sourceId) || (i === path.length - 1 && n.id === targetId)) continue
      if (segmentHits(path[i - 1], path[i], n)) { cost += 1_000_000; break }
    }
    if (cost >= best) break
    for (const stroke of ink) if (segmentHits(path[i - 1], path[i], stroke)) cost += 100
  }
  return cost
}
function placeLabels(nodes: RouteNode[], ordered: RouteEdge[], result: Map<string, EdgeDrawing>, ink: RouteBox[]) {
  const labelObstacles = nodes.map(n => n.group ? { ...n, height: Math.min(48, n.height) } : n)
  const labels: RouteBox[] = []
  const boxFor = (p: Point, e: RouteEdge): RouteBox => {
    const width = e.labelSize?.width ?? Math.min(240, (e.label?.length ?? 0) * 7 + 12)
    const height = e.labelSize?.height ?? Math.ceil(((e.label?.length ?? 0) * 7 + 12) / 240) * 18 + 4
    return { x: p.x - width / 2, y: p.y - height / 2, width, height }
  }
  // Manual placements are obstacles for automatic labels, regardless of edge order.
  for (const edge of ordered) {
    const drawing = result.get(edge.id)
    if (!drawing || !edge.label || !edge.labelOffset) continue
    drawing.label = { x: drawing.anchor.x + edge.labelOffset.x, y: drawing.anchor.y + edge.labelOffset.y }
    labels.push(boxFor(drawing.label, edge))
  }
  for (const edge of ordered) {
    const drawing = result.get(edge.id)
    if (!drawing || !edge.label || edge.labelOffset) continue
    const fits = (p: Point) => {
      const box = boxFor(p, edge)
      return !labelObstacles.some(n => overlaps(box, n, 8)) && !labels.some(l => overlaps(box, l, 8)) && !ink.some(line => overlaps(box, line, 2))
    }
    let placed = false
    for (let offset = 14; offset <= 180 && !placed; offset += 18) {
      for (const p of [{ x: drawing.anchor.x, y: drawing.anchor.y - offset }, { x: drawing.anchor.x, y: drawing.anchor.y + offset }, { x: drawing.anchor.x + offset, y: drawing.anchor.y }, { x: drawing.anchor.x - offset, y: drawing.anchor.y }]) {
        if (fits(p)) { drawing.label = p; placed = true; break }
      }
    }
    if (!placed) {
      // Dense diagrams still get legible labels, connected back by a leader.
      const right = Math.max(0, ...nodes.map(n => n.x + n.width), ...ink.map(n => n.x + n.width))
      const p = { x: right + 150, y: drawing.anchor.y }
      while (!fits(p)) p.y += boxFor(p, edge).height + 12
      drawing.label = p
    }
    labels.push(boxFor(drawing.label, edge))
  }
}
