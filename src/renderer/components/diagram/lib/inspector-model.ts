import type { DiagramDoc, DiagramEdge, DiagramNode } from '../../../../shared/diagram-types'
import { z } from 'zod'

const edgeLabelSchema = z.string().catch('')

/**
 * The node inspector's tabs, in the order they always appear. Comments is last
 * and never becomes the default — but it persists like the others.
 */
export const INSPECTOR_TABS = ['identity', 'style', 'data', 'links', 'comments'] as const
export type InspectorTab = (typeof INSPECTOR_TABS)[number]

/**
 * An edge is editable, so it gets the same footprint as a node — only the
 * contents differ. Route replaces Data and Links: an edge's structure *is* its
 * endpoints.
 */
export const EDGE_INSPECTOR_TABS = ['identity', 'style', 'route', 'comments'] as const
export type EdgeInspectorTab = (typeof EDGE_INSPECTOR_TABS)[number]

/**
 * The relationship enum, spelled once. The Identity tab renders these as its
 * segmented control and the panel header lowercases the same label into its
 * sub-line, so the two can never disagree about what a `data` edge is called.
 */
export const EDGE_KINDS: {
  kind: NonNullable<DiagramEdge['kind']>
  label: string
  hint: string
}[] = [
  { kind: 'sync', label: 'Sync', hint: 'Direct, synchronous call' },
  { kind: 'async', label: 'Async', hint: 'Animated, dashed — async / event flow' },
  { kind: 'data', label: 'Data', hint: 'Thicker line — data transfer' },
]

/** Routing styles, likewise shared by the Route tab and the header's route chip. */
export const EDGE_ROUTES: {
  route: NonNullable<DiagramEdge['route']>
  label: string
  hint: string
  /** Preview glyph for the segmented control, drawn in a 21×12 viewBox. */
  path: string
}[] = [
  { route: 'smooth', label: 'Orthogonal', hint: 'Rounded orthogonal step', path: 'M3 9h12a3 3 0 003-3V3' },
  { route: 'step', label: 'Step', hint: 'Sharp orthogonal corners', path: 'M3 9h15V3' },
  { route: 'straight', label: 'Straight', hint: 'Direct line', path: 'M3 9L18 3' },
]

/** Display name of an edge's relationship, resolving the `sync` default. */
export function edgeKindLabel(kind: DiagramEdge['kind']): string {
  return (EDGE_KINDS.find((k) => k.kind === kind) ?? EDGE_KINDS[0]).label
}

/** Display name of an edge's routing, resolving the `smooth` default. */
export function edgeRouteLabel(route: DiagramEdge['route']): string {
  return (EDGE_ROUTES.find((option) => option.route === route) ?? EDGE_ROUTES[0]).label
}

/**
 * One handler per editable edge property. Passed down as a single object so a
 * tab takes one prop instead of seven, and so adding a property is one edit.
 */
export interface EdgeUpdates {
  label: (id: string, label: string) => void
  body: (id: string, body: string | undefined) => void
  kind: (id: string, kind: NonNullable<DiagramEdge['kind']>) => void
  color: (id: string, color: string | undefined) => void
  width: (id: string, width: number | undefined) => void
  dash: (id: string, dash: DiagramEdge['dash']) => void
  arrows: (id: string, arrows: NonNullable<DiagramEdge['arrows']>) => void
  route: (id: string, route: NonNullable<DiagramEdge['route']>) => void
  cardinality: (id: string, cardinality: DiagramEdge['cardinality']) => void
}

/** One edge touching the inspected node, seen from that node's side. */
export interface NodeLink {
  edgeId: string
  direction: 'in' | 'out'
  /** Label of the node at the other end. */
  otherLabel: string
  /** The edge's own label, if it carries one. */
  label: string
}

/** Minimal edge data the links list needs — satisfied by an xyflow edge. */
interface LinkSource {
  id: string
  source: string
  target: string
  label?: unknown
}

/**
 * Every edge touching `nodeId`, outgoing first. Both directions live in one list
 * because the Links tab reads as "what this node is wired to", not as two
 * separate inventories.
 */
export function nodeLinks(
  nodeId: string,
  edges: LinkSource[],
  labelOf: (id: string) => string,
): NodeLink[] {
  const links: NodeLink[] = []
  for (const e of edges) {
    const label = edgeLabelSchema.parse(e.label)
    // Not `else if`: a self-edge is genuinely both an outgoing and an incoming
    // connection, so it earns a row and a degree count on each side.
    if (e.source === nodeId) {
      links.push({ edgeId: e.id, direction: 'out', otherLabel: labelOf(e.target), label })
    }
    if (e.target === nodeId) {
      links.push({ edgeId: e.id, direction: 'in', otherLabel: labelOf(e.source), label })
    }
  }
  return links.sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1))
}

/** Degree of the node, split by direction. A self-edge counts on both sides. */
export interface NodeDegree { in: number; out: number }

export function nodeDegree(links: NodeLink[]): NodeDegree {
  return {
    in: links.filter((l) => l.direction === 'in').length,
    out: links.filter((l) => l.direction === 'out').length,
  }
}

/**
 * The node a level selects the moment it mounts, so the inspector is never empty
 * on a level you deliberately entered. The graph's entry point — the first node
 * nothing points at — or simply the first node when everything is in a cycle.
 */
export function anchorNodeId(doc: DiagramDoc): string | null {
  if (!doc.nodes.length) return null
  const pointedAt = new Set(doc.edges.map((e) => e.target))
  return (doc.nodes.find((n) => !pointedAt.has(n.id)) ?? doc.nodes[0]).id
}

/**
 * The one-word kind the collapsed rail names on hover. The node's own
 * `subtitle` is the authored kind; the fallbacks describe what the node is
 * structurally when the author left it blank.
 */
export function railKindWord(node: DiagramNode): string {
  if (node.subtitle?.trim()) return node.subtitle.trim()
  if (node.group) return 'Group'
  if (node.fields?.length) return 'Dataset'
  return 'Node'
}
